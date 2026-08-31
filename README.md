# Emergency Department Simulator

A planning tool for emergency department people-flow, in two halves that share a
top bar:

- **PLAN** — trace a floorplan into zones, nodes and routes, then record who
  walks them, how long each leg takes and how far it is.
- **SIMULATE** — a discrete-event simulation of patient flow, calibrated from a
  real dataset of 114,837 visits (one full year).

```
Arrival -> Condition of Concern -> Triage -> P1 / P2 / P3 zone
        -> Doctor review -> Disposition -> Discharge / Admit / EDTU / Decant
```

A third program, `ed_simulation.py`, runs the same simulation headlessly for
batch runs and capacity sweeps.

> **PLAN and SIMULATE are not yet wired together.** PLAN's zone capacities,
> role staffing and route durations are stored and exported, but nothing feeds
> them into the simulation — SIMULATE runs purely off `Params.json`.

---

## Quick start

Both pages expect to be served over HTTP. Opening them by double-click
(`file://`) does not work properly: SIMULATE will not start at all, and PLAN's
PNG export fails. From the repository root:

```bash
python3 -m http.server 8000
```

Then open:

- PLAN — <http://localhost:8000/ed_flow_annotator.html>
- SIMULATE — <http://localhost:8000/ed_flow_sim.html>

Stop the server with `Ctrl-C`, or from another terminal:

```bash
lsof -ti tcp:8000 | xargs kill
```

Any static server works — `npx serve`, `php -S localhost:8000`, whatever you
have. Nothing is compiled and there is no build step.

### Why a server is required

- SIMULATE fetches `params.json` at startup; browsers block `fetch()` from
  `file://` for security. The page detects this and tells you what to do.
- PLAN's PNG export draws the floorplan into a canvas. Under `file://` the
  canvas is treated as cross-origin and the export throws.

### If you are on Linux

The parameter file on disk is named `Params.json` with a capital P, but both
engines ask for `params.json`. macOS and Windows ignore case and resolve it
anyway; Linux and most containers do not, so the simulator will fail to start.

Rename it once, via a temporary name so the rename also works on
case-insensitive filesystems:

```bash
mv Params.json tmp.json && mv tmp.json params.json
```

Or leave it alone and add an alias alongside it (Linux only — on macOS this
errors, because the name is already taken by the same file):

```bash
ln -s Params.json params.json
```

---

## Repository layout

| Path | What it is |
|---|---|
| `ed_flow_annotator.html` | PLAN — markup and page styles |
| `plan.js` | PLAN — drawing, geometry, properties, import/export |
| `ed_flow_sim.html` | SIMULATE — markup, styles and simulation engine |
| `nuhs.css` | Shared design tokens and shell chrome |
| `nuhs-shell.js` | Shared top bar, Settings, dialogs |
| `assets/template_map.png` | Fallback floorplan used by **Skip** |
| `assets/icons/` | Six role glyphs, white on transparent, tinted at runtime |
| `Params.json` | Fitted parameters (see [Linux note](#if-you-are-on-linux)) |
| `ed_simulation.py` | Headless SimPy engine |
| `_original/` | The two pre-redesign pages, for reference |
| `_docs/design-nuhs.md` | Brand and design guide the UI follows |
| `_mockups/` | Design mockups the redesign was built against |

Everything works offline apart from a Google Fonts stylesheet, which falls back
to system fonts when there is no connection.

---

## 1. PLAN

Pick a tool on the left, then use the **+ Add** button in the right rail. The
tool rail stays disabled until a floorplan is loaded.

**Getting a map in.** *Upload map* takes any image file. *Skip* loads
`assets/template_map.png` pre-seeded with eleven zones and a node in each, so
you can start drawing routes immediately.

**Zones** — rectangle or polygon. Polygons need at least three points and close
on a double-click. Each zone carries a name, colour and capacity.

**Nodes** — the touchpoints inside a zone that people actually walk to. A node
defaults to the colour of the zone it lands in, and its zone is detected
automatically.

**Routes** — chain nodes together. Click a node to start, click each next node
and give the leg a duration, then double-click the last node to finish and set
the label and role. Only nodes are clickable; a route takes the colour of the
role that walks it.

**Roles** — six fixed roles (Doctor, Nurse, Consultant, Patient, Porter, Other).
Each can be renamed and given a staffing number and colour. Patient's number is
arrivals per day, not staff.

**Scale** — draw a line over a known distance and enter its length in metres.
Distances then read in metres and a scale bar appears on the map and in the PNG
export. Without it, distances stay in pixels.

### Keyboard

| Key | Action |
|---|---|
| `Space` (hold) | Pan |
| Scroll | Zoom |
| `F` | Fit map to window |
| `Esc` | Cancel the current drawing, or clear the selection |
| `Delete` / `Backspace` | Delete the selection |
| Double-click | Finish a polygon or a route |

### Saving and files

PLAN autosaves to browser storage as you work and restores on reload. **Save**
forces a write; **Export** writes a `.json` plan; **Import** reads one back and
also upgrades files from the previous annotator format. **PNG** exports the
annotated floorplan at the image's native resolution.

Browser storage is per-browser and per-origin — it does not travel between
machines. Use Export for anything you want to keep or share.

To start from scratch, clear the saved plan from the browser console:

```js
['nuhs-ed-plan-v1','nuhs-ed-plan-ui','nuhs-ed-settings-v1','nuhs-ed-sim-caps-v1']
  .forEach(k => localStorage.removeItem(k));
```

---

## 2. SIMULATE

Runs as soon as the page loads.

1. Drag the capacity sliders, or click any number and type a value.
2. Watch the flow: each dot is a patient, coloured by acuity (red P1, orange
   P2, green P3), moving Arrival/Triage → Zones → Disposition → Boarding Ward →
   Departed.
3. P1, P2, P3 and Boarding Ward show `used / capacity`, and their borders fill
   clockwise from the top-left corner as they approach capacity.
4. The panels below show resource utilization and rolling median/p90 wait per
   acuity over the last six simulated hours.
5. **Pause**/**Play** and **Speed** control playback; **Reset** restarts the
   clock and keeps your capacities.

A `queue backing up` badge appears when any single queue passes 15 waiting
patients.

**Export** writes a JSON snapshot of the run — capacities, occupancy and the
rolling wait statistics. Import and PNG are Plan-side actions and stay disabled
here.

---

## 3. The headless engine

**Requirements:** Python 3.8+ and `simpy`.

```bash
pip install simpy
# if your system restricts global installs:
#   pip install simpy --break-system-packages

# run from the repository root — the script reads params.json from the
# working directory
python3 ed_simulation.py

# or override any capacity to test a scenario
python3 ed_simulation.py --days 30 --p2-capacity 20 --doctors 20
```

> The checked-in `flowSimEnv/` virtualenv was created on a different machine and
> its interpreter symlinks are dead. Either create your own venv, or point
> Python at the vendored copy of simpy:
> ```bash
> PYTHONPATH=flowSimEnv/lib/python3.11/site-packages python3 ed_simulation.py
> ```

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
| `--boarding-slots` | 8 | Slots for admitted patients waiting to leave for the ward |

Output is a summary of median/p90 arrival-to-disposition time by acuity, plus
overall arrival-to-departure, printed to the terminal.

### Example: finding the bottleneck

```bash
for cap in 15 20 25 30 35; do
  echo "--- p2-capacity=$cap ---"
  python3 ed_simulation.py --days 30 --p2-capacity $cap
done
```

This is how the default capacities were chosen — P2 zone capacity is the binding
constraint: dropping it from 30 to 20 roughly triples P2 wait times, and
dropping to 15 blows the queues up entirely (median wait past 2,700 minutes, so
the system never reaches steady state).

---

## How the model is calibrated

Every duration is a **lognormal fit to the real data**, separately per triage
acuity where the data supports it:

- Triage wait and duration
- Doctor wait, by triage acuity
- In-zone treatment time, by consult (post-triage) acuity
- Post-disposition processing (discharge paperwork, decant transfer, EDTU transfer)
- Admission chain: bed request wait → bed assigned → boarding → admit

Branch probabilities are the **empirical transition rates** from the same data,
not assumptions:

- **Up/down-triage matrix** — the chance a patient triaged at one acuity is seen
  at another after doctor review (P3 → P2 in about 22% of cases).
- **Disposition mix per acuity** — P1 patients are admitted 81% of the time
  versus 12% discharged; P3 patients are discharged 95% of the time.
- **Arrivals** follow the real hour-of-day curve, from about 3 patients/hour at
  4–5am to 24/hour at 10–11am, rather than a flat average.

The default capacities (4 triage nurses, 25 doctors, 4 P1 bays, 30 P2, 40 P3,
8 boarding slots) are **not from a spec sheet** — they are the combination that
best reproduces the observed real-world medians (P1 ≈ 28 min, P2 ≈ 116 min,
P3 ≈ 154 min arrival-to-disposition). Treat them as the calibrated baseline and
move away from them to explore scenarios.

## Known simplifications

- **The two engines disagree about doctor priority.** `ed_simulation.py` queues
  doctors through a SimPy `PriorityResource` keyed on triage acuity, so P1 jumps
  the queue. The browser engine assigns doctors in patient order with no
  priority. Under load the two produce different P1 waits from identical inputs.
- **P3 is optimistic.** Simulated P3 arrival-to-disposition lands near 117 min
  against a real median of 154. P1 and P2 track the real data closely.
- **`triage_wait` is fitted but never sampled.** Queueing for a triage nurse is
  emergent from capacity instead, so observed triage waits are not reproduced
  directly.
- **Doctors are one shared pool** across all three zones. If the real department
  runs zone-dedicated teams, the model needs three pools — a small change in
  both engines.
- **No day-of-week seasonality** — only hour-of-day arrival volume is modelled.
- **No explicit "Condition of Concern" bypass** — patients who should skip the
  triage queue are approximated by the P1 acuity split rather than a fast-track
  path.
- **Acuity is drawn after triage**, from a global distribution, so arrival hour
  and case mix are independent.

## Files referenced but not included

`Overall_Flow.pdf` (the process map), `ED_Dataset.xlsx` (the source data) and
`fit_params.py` (the fitting script) are all referenced in the code and comments
but are not in this repository. Without the fitting script, `Params.json` cannot
be regenerated from a newer export.
