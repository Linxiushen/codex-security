# Completed-report merge evaluation

These synthetic fixtures measure merging alone. They contain no source targets,
discovery tasks, or reproduction steps. The oracle tests independent findings
with similar titles, duplicates with distinct repairs, accepted aliases,
conflicting severities, and a field larger than ordinary tool output with useful
facts at its end and in nested history.

Run the deterministic oracle and its negative controls:

```sh
bun test tests-ts/merge-eval.test.ts
```

Measure separate versus batched checked artifact writes with 24 alternating
paired samples and byte verification (requires a built bundled plugin):

```sh
bun scripts/merge-eval/benchmark.ts /absolute/path/to/python3
```

That microbenchmark reports only input-publication latency and process count.

Replay a real sealed synthetic child through composition, parent publication,
SQLite indexing and seal validation, alternating separate and batched input writes:

```sh
bun scripts/merge-eval/replay.ts /absolute/path/to/python3 12
```

This reports the host time from the last required child result to the sealed,
indexed parent. Its model output is fixed and correct; model latency and quality
must be measured separately. It checks finding count, partial coverage, retained
child bytes, and the rendered report after each sample.

An explicit model run uses the existing Codex login and incurs model usage:

```sh
bun scripts/merge-eval/run.ts /absolute/path/to/results MODEL 3
```

The runner disables plugins, apps, subagents, web search, and network access for
the merge thread. It uses a temporary directory containing only synthetic merge
inputs. It retains inputs, raw responses, usage, elapsed time, and thread IDs
for review. The fixture oracle is not included in the prompt or that directory.

Two independent gates apply: the production validator checks structural source
accounting and preservation, while `grade.ts` checks expected partitions,
severity, and named repair facts in canonical fields. Full archived originals
cannot hide an omitted canonical repair. Named facts are a closed-world rubric;
inspect semantic paraphrases and unexpected outcomes independently rather than
tuning the oracle to a candidate's output. These cases do not establish general
scan precision or recall.

For comparison, run the same held-out cases against baseline and candidate at
identical model/runtime settings, alternate order, and report p50/p95, usage and
error rate with raw samples. Any failed quality gate disqualifies a speed win.
This runner times model merging and validation; it does **not** time parent
publication. Measure completion-to-sealed-parent separately with real artifact
and database operations before claiming end-to-end improvement.
