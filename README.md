# ED Flow Simulation

A discrete-event simulation of emergency department patient flow, calibrated from a real dataset of 114,837 patient visits (1 full year). It follows the process map in `Overall_Flow.pdf`:

```
Arrival -> Condition of Concern -> Triage -> P1 / P2 / P3 zone
        -> Doctor review -> Disposition -> Discharge / Admit / EDTU / Decant
```

There are two implementations of the same model:

| File | What it's for |
|---|---|
| `ed_flow_sim.html` | Animated, interactive visualization. Drag sliders to change staffing/capacity and watch queues form in real time. No install required. |
| `ed_simulation.py` | Headless SimPy engine for batch runs, capacity sweeps, and getting hard numbers instead of a picture. |
| `params.json` | The fitted parameters both implementations run on (lognormal duration fits, branch probabilities, arrival-rate curve). |

## 1. Running the visualization

No setup needed.

1. Open `ed_flow_sim.html` in any modern browser (double-click the file, or drag it into a browser window).
2. Use the sidebar sliders to adjust triage nurses, doctors, P1/P2/P3 zone capacity, and ward boarding slots.
3. Watch the flow diagram: dots represent patients, colored by acuity (red = P1, orange = P2, green = P3), moving through Arrival/Triage → Zones → Disposition → Departed.
4. The stats panel on the right shows rolling median/p90 wait times per acuity (last 6 simulated hours) and resource utilization bars.
5. Use **Pause**/**Play** and the **Speed** slider to slow down or fast-forward; **Reset** restarts the clock.

It works fully offline except for a Google Fonts stylesheet link (falls back to system fonts if you have no internet connection).

## 2. Running the Python engine

**Requirements:** Python 3.8+, and the `simpy` package.

```bash
# 1. Install the dependency
pip install simpy
# (if your system restricts global installs: pip install simpy --break-system-packages)

# 2. Keep ed_simulation.py and params.json in the same folder — the script
#    reads params.json from its working directory.

# 3. Run with default (calibrated) settings
python3 ed_simulation.py

# 4. Or override any capacity to test a scenario
python3 ed_simulation.py --days 30 --p2-capacity 20 --doctors 20
```


```bash
python3 -m http.server 8000

# then visit 
http://localhost:8000/ed_flow_sim.html
http://localhost:8000/ed_flow_annotator.html

# Make sure params.json sits in the same folder as this HTML file.
```

### Command-line options

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 14 | Number of simulated days (first day is discarded as warm-up) |
| `--seed` | 42 | Random seed, for reproducible runs |
| `--triage-nurses` | 4 | Concurrent triage stations |
| `--doctors` | 25 | Size of the shared doctor pool (P1 gets priority queueing) |
| `--p1-bays` | 4 | Resuscitation bay capacity |
| `--p2-capacity` | 30 | P2 management area capacity |
| `--p3-capacity` | 40 | P3 ambulatory area capacity |
| `--boarding-slots` | 8 | Slots for admitted patients waiting to physically leave for the ward |

Output is a summary of median/p90 arrival-to-disposition time by acuity, plus overall arrival-to-departure, printed to the terminal.

### Example: finding the bottleneck

```bash
for cap in 15 20 25 30 35; do
  echo "--- p2-capacity=$cap ---"
  python3 ed_simulation.py --days 30 --p2-capacity $cap
done
```

This is how the default capacities were chosen — `P2 zone capacity` turned out to be the binding constraint in this system: dropping it from 30 to 20 roughly triples P2 wait times, and dropping to 15 causes queues to blow up (median wait exceeds 5,000 minutes, i.e. the system doesn't reach steady state).

## How the model is calibrated

Every duration is a **lognormal distribution fit to the real data**, separately per triage acuity where the data supports it:

- Triage wait and duration
- Doctor wait, by triage acuity
- In-zone treatment time, by consult (post-triage) acuity
- Post-disposition processing time (discharge paperwork, decant transfer, EDTU transfer)
- Admission chain: bed request wait → bed assigned → boarding → admit

Branch probabilities are the **empirical transition rates** observed in the data, not assumptions:

- **Up/down-triage matrix** — probability a patient triaged at P1/P2/P3 ends up being seen at a different acuity after doctor review (e.g. P3 → P2 in ~22% of cases).
- **Disposition mix per acuity** — e.g. P1 patients are admitted 81% of the time vs. discharged 12%; P3 patients are discharged 95% of the time.
- **Arrivals** follow the real hour-of-day volume curve (from ~3 patients/hour at 4–5am to ~24/hour at 10–11am), not a flat average.

The default capacities (4 triage nurses, 25 doctors, 4 P1 bays, 30 P2 capacity, 40 P3 capacity, 8 boarding slots) are **not from a spec sheet** — they're the combination that reproduces the observed real-world median wait times most closely (P1 ≈ 28 min, P2 ≈ 116 min, P3 ≈ 154 min arrival-to-disposition). Treat them as the calibrated baseline, and move the sliders away from them to explore "what if we had fewer/more of X" scenarios.

## Known simplifications

- **Doctors are one shared pool** across all three zones. Real EDs often have zone-dedicated clinical teams; if that's true here, the model should be split into three separate doctor pools (P1/P2/P3), which would need a small change to `ed_simulation.py` and the JS engine in `ed_flow_sim.html`.
- **No day-of-week seasonality** — only hour-of-day arrival volume is modeled. If weekday/weekend patterns matter for your planning question, the dataset has the raw dates to fit that too.
- **No explicit "Condition of Concern" bypass modeling** — patients who should skip the triage queue entirely (chest pain, SOB, stroke arriving critical) are approximated by the P1 acuity split rather than a separate fast-track path.
- Regenerating `params.json` from a newer or larger dataset just requires re-running the fitting steps described above against the new export — ask if you want that turned into a standalone script.