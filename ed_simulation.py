"""
Emergency Department people-flow discrete-event simulation.

Calibrated from ED_Dataset.xlsx (114,837 real patient visits, 1 full year)
using the process map in Overall_Flow.pdf:

    Arrival -> Condition of Concern (bypass?) -> Triage -> P1/P2/P3 area
             -> Doctor review -> Disposition -> Discharge/Admit/EDTU/Decant

Every duration below is fit as a lognormal from the real data (see params.json,
produced by fit_params.py). Branch probabilities (up/down-triage, disposition
splits) are the empirical transition matrices from the same data.

Run:
    python3 ed_simulation.py --days 30 --triage-nurses 3 --doctors 25 \
        --p1-bays 4 --p2-capacity 20 --p3-capacity 20 --boarding-slots 8
"""
import argparse
import json
import random
import statistics
from dataclasses import dataclass, field

import simpy

with open("params.json") as f:
    P = json.load(f)


def lognormal(spec, rng):
    """Sample from a fitted lognormal; spec has mu/sigma of the underlying normal."""
    if spec is None:
        return 1.0
    return max(0.1, rng.lognormvariate(spec["mu"], spec["sigma"]))


def weighted_choice(dist: dict, rng):
    keys = list(dist.keys())
    weights = list(dist.values())
    return rng.choices(keys, weights=weights, k=1)[0]


@dataclass
class Patient:
    pid: int
    arrival_min: float
    triage_acuity: str = None
    consult_acuity: str = None
    disposition: str = None
    t_triage_start: float = None
    t_triage_end: float = None
    t_doc_seen: float = None
    t_dispo: float = None
    t_depart: float = None

    @property
    def arrival_to_dispo(self):
        return None if self.t_dispo is None else self.t_dispo - self.arrival_min

    @property
    def arrival_to_depart(self):
        return None if self.t_depart is None else self.t_depart - self.arrival_min


@dataclass
class EDModel:
    env: simpy.Environment
    rng: random.Random
    triage_nurses: simpy.Resource
    doctors: simpy.Resource
    p1_bays: simpy.Resource
    p2_capacity: simpy.Resource
    p3_capacity: simpy.Resource
    boarding_slots: simpy.Resource
    patients: list = field(default_factory=list)

    def zone_resource(self, acuity):
        return {"P1": self.p1_bays, "P2": self.p2_capacity, "P3": self.p3_capacity}[acuity]

    def run_patient(self, patient: Patient):
        env, rng = self.env, self.rng

        # --- Triage ---
        with self.triage_nurses.request() as req:
            yield req
            patient.t_triage_start = env.now
            yield env.timeout(lognormal(P["triage_duration"], rng))
            patient.t_triage_end = env.now

        patient.triage_acuity = weighted_choice(P["triage_acuity_dist"], rng)
        # up/down-triage after doctor review
        trans = P["acuity_transition"][patient.triage_acuity]
        patient.consult_acuity = weighted_choice(trans, rng)

        # --- Hold a zone bay + doctor for the consult/treatment period ---
        priority = {"P1": 0, "P2": 1, "P3": 2}[patient.triage_acuity]
        zone = self.zone_resource(patient.consult_acuity)
        with zone.request() as zreq:
            yield zreq
            with self.doctors.request(priority=priority) as dreq:
                yield dreq
                yield env.timeout(lognormal(P["doc_wait"][patient.triage_acuity], rng))
                patient.t_doc_seen = env.now
            # zone/treatment time happens while occupying the bay (doctor freed up)
            yield env.timeout(lognormal(P["zone_time"][patient.consult_acuity], rng))
            patient.t_dispo = env.now

        # --- Disposition branch ---
        patient.disposition = weighted_choice(P["disposition_dist"][patient.consult_acuity], rng)

        if patient.disposition == "Discharge":
            yield env.timeout(lognormal(P["discharge_time"], rng))
            patient.t_depart = env.now
        elif patient.disposition == "Decant":
            yield env.timeout(lognormal(P["decant_time"], rng))
            patient.t_depart = env.now
        elif patient.disposition == "EDTU":
            yield env.timeout(lognormal(P["edtu_time"], rng))
            patient.t_depart = env.now
        elif patient.disposition == "Admit":
            yield env.timeout(lognormal(P["admit_bed_req_wait"], rng))
            yield env.timeout(lognormal(P["admit_req_to_assigned"], rng))
            with self.boarding_slots.request() as breq:
                yield breq
                yield env.timeout(lognormal(P["admit_assigned_to_admit"], rng))
            patient.t_depart = env.now

        self.patients.append(patient)


def arrivals(env, model, rng, sim_days):
    pid = 0
    hourly = {int(h): r for h, r in P["arrival_rate_per_hour"].items()}
    while env.now < sim_days * 1440:
        hour = int(env.now // 60) % 24
        rate_per_hour = hourly[hour]
        if rate_per_hour <= 0:
            yield env.timeout(60)
            continue
        interarrival = rng.expovariate(rate_per_hour / 60.0)
        yield env.timeout(interarrival)
        pid += 1
        patient = Patient(pid=pid, arrival_min=env.now)
        env.process(model.run_patient(patient))


def run_simulation(sim_days, seed, capacities):
    rng = random.Random(seed)
    env = simpy.Environment()
    model = EDModel(
        env=env,
        rng=rng,
        triage_nurses=simpy.Resource(env, capacity=capacities["triage_nurses"]),
        doctors=simpy.PriorityResource(env, capacity=capacities["doctors"]),
        p1_bays=simpy.Resource(env, capacity=capacities["p1_bays"]),
        p2_capacity=simpy.Resource(env, capacity=capacities["p2_capacity"]),
        p3_capacity=simpy.Resource(env, capacity=capacities["p3_capacity"]),
        boarding_slots=simpy.Resource(env, capacity=capacities["boarding_slots"]),
    )
    env.process(arrivals(env, model, rng, sim_days))
    env.run(until=sim_days * 1440)
    return model.patients


def summarize(patients, warmup_min=1440):
    """Drop the first day as warm-up, then report stats by triage acuity."""
    steady = [p for p in patients if p.arrival_min >= warmup_min and p.t_dispo is not None]
    print(f"\nPatients simulated (post warm-up): {len(steady)}")
    for acuity in ["P1", "P2", "P3"]:
        vals = [p.arrival_to_dispo for p in steady if p.triage_acuity == acuity]
        if not vals:
            continue
        vals.sort()
        median = statistics.median(vals)
        p90 = vals[int(0.9 * len(vals))]
        print(f"  {acuity}: n={len(vals):>6}  median arrival->dispo={median:6.1f} min  p90={p90:6.1f} min")

    depart_vals = [p.arrival_to_depart for p in steady if p.t_depart is not None]
    if depart_vals:
        depart_vals.sort()
        print(f"\n  Overall median arrival->depart: {statistics.median(depart_vals):.1f} min "
              f"(p90={depart_vals[int(0.9*len(depart_vals))]:.1f} min)")

    real = {"P1": 28.0, "P2": 116.0, "P3": 154.0}
    print("\n  (Real-data medians for arrival->dispo were P1=28, P2=116, P3=154 min --")
    print("   compare against the simulated numbers above to sanity-check calibration.)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--triage-nurses", type=int, default=4)
    ap.add_argument("--doctors", type=int, default=25)
    ap.add_argument("--p1-bays", type=int, default=4)
    ap.add_argument("--p2-capacity", type=int, default=30)
    ap.add_argument("--p3-capacity", type=int, default=40)
    ap.add_argument("--boarding-slots", type=int, default=8)
    args = ap.parse_args()

    caps = {
        "triage_nurses": args.triage_nurses,
        "doctors": args.doctors,
        "p1_bays": args.p1_bays,
        "p2_capacity": args.p2_capacity,
        "p3_capacity": args.p3_capacity,
        "boarding_slots": args.boarding_slots,
    }
    print(f"Running {args.days}-day simulation with capacities: {caps}")
    patients = run_simulation(args.days, args.seed, caps)
    summarize(patients)