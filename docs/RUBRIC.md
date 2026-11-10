# Judging rubric (derived from Zamp's candidate guide)

Score each criterion 0–10 with evidence. Weights reflect what the guide says it cares about: "whether your process actually works, the judgment behind your design choices, and how you explain it to a non-technical buyer", plus "the UI is part of the grade".

| # | Criterion | Weight | What a 10 looks like |
|---|---|---|---|
| 1 | Actually runs end to end on real input | 20 | Upload any invoice PDF or image: it is really extracted, really matched, and a real decision comes out. No mock paths. Failure modes (API down, junk file, huge file) are handled gracefully. |
| 2 | Edge cases: realistic, non-trivial, deliberate | 20 | 2–4 well-chosen cases that show an understanding of AP (3-way match, split invoicing, duplicates, BEC fraud, scanned/no-PO). Each behaves differently from the happy path for a stated reason. |
| 3 | Decision quality and explainability | 15 | Every decision carries reasons, numbers and a plain-English explanation; deterministic and reproducible; right routing; human-in-the-loop for holds. |
| 4 | Live run view (each stage as it executes) | 15 | You can watch stages progress; each stage shows what it checked and found; evidence (document, extracted fields, bank comparison, line matches) is visible. |
| 5 | Dashboard of past runs | 10 | History, status, outputs, KPIs, filters; drill into any run. |
| 6 | UI craft | 10 | Intuitive, clear hierarchy, consistent, polished, accessible, responsive, no broken states. |
| 7 | Explainable to a non-technical buyer | 5 | Copy and the process map make sense to an AP manager; a demo script exists. |
| 8 | Engineering judgment | 5 | Sensible stack, tests, eval script, honest limits documented, deployable. |

Total = Σ(score × weight) / 10, out of 100.
