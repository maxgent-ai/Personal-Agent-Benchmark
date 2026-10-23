# Tasks

One directory per task under `tasks/`:

```text
tasks/<id>/
  task.yaml          the task card
  bundle.tar.gz      the recording (bundle.tar.gz.000, .001, ... when larger than 45 MB)
  bundle.json        summary of the recording, generated with it
  rules/             site rules for this task
    <site>.auto.yaml   inferred from the recording; regenerated on every import, do not edit
    <site>.yaml        written by people; corrections and additions
  compute.yaml       cart and checkout computation (only for tasks that need it)
```

## task.yaml

```yaml
id: amazon-airpods
title: Buy AirPods Pro 3 on Amazon
prompt: >-                       # the instruction given to the agent
  I want Apple AirPods Pro 3 from Amazon, shipped to New York (ZIP 10001). ...
start_url: https://www.amazon.com/
sites: [amazon.com]
capture:                         # for the person recording the task
  region: { country: US, zip: "10001" }
  locale: en-US
  timezone: America/New_York
  guide: |
    1. Set the delivery ZIP to 10001 first.
    ...
```

## Which rules apply

A task is replayed with `sites/` and then `tasks/<id>/rules/` layered over each other:

1. Hand-written files (`<site>.yaml`) win over inferred ones (`<site>.auto.yaml`), wherever they are.
2. Among hand-written files, the task's own win over `sites/`.
3. Endpoints of the winning file are tried first and its single values are kept; lists such as
   `drop_params` and `block` are combined.

So a correction that only matters for one task goes into `tasks/<id>/rules/<site>.yaml`, and one
that helps every task on the site goes into `sites/<site>.yaml`. See [site-rules.md](site-rules.md).

## How a task is added

Recordings are made with the maintainers' recording tool, which is not part of this repository.
The steps are:

1. A maintainer writes `tasks/<id>/task.yaml`, including `capture.guide`.
2. A person records the task: browse first (searches in several wordings, product pages, policy
   pages), then act (add to cart, change quantity, try a code). Bot checks are completed by that
   person, never by a script; orders are never placed. The tool packs the recording, removes
   cookies, credentials and listed personal data, infers site rules, and replays every recorded
   page once to measure hit rates.
3. A maintainer imports the recording. The import refuses recordings that fail `pab audit` or the
   personal-data scan, writes `bundle.tar.gz`, `bundle.json` and `rules/*.auto.yaml`, and leaves
   hand-written files alone.
4. The maintainer replays the task (`pab replay <id>`), adds `compute.yaml` if the task reaches a
   cart or checkout ([compute.md](compute.md)), fixes misses with rules, and opens a pull request.

Re-recording a task replaces `bundle.tar.gz` and the `*.auto.yaml` files. Prices and pages change
over time, so `compute.yaml` must be checked again (`pab compute-check <id>`).

To propose a task, open an issue with the instruction, the start URL and the sites involved.
