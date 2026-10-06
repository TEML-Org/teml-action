# teml-action

A GitHub Action for teams that keep [TEML](https://teml.org) Event Models in their repository. On each pull request that changes a model, it posts one comment, and updates it on every push, with:

- the changes, slice by slice: slices added, removed or changed (status, trigger, events, view updates, readers, specs), with the reason when a slice is declined;
- links that open the board before and after the change in the [TEML viewer](https://tools.teml.org/);
- the results of `teml check`, which also appear as annotations on the changed lines.

Review the model the way you review code: discuss it in the pull request, and merging records the decision.

## Usage

```yaml
# .github/workflows/teml.yml
name: TEML
on: pull_request

jobs:
  teml:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # to post the comment
    steps:
      - uses: actions/checkout@v4
      - uses: TEML-Org/teml-action@v1
```

It works in private repositories too: it reads the models with the workflow's own token, and the only thing it downloads is the `teml` command from tools.teml.org.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `files` | `**/*.teml.yaml` | Which files are TEML models. One glob per line; `**` matches any folders. |
| `fail-on-error` | `true` | Fail the job when `teml check` finds an error in a changed model. Warnings, and anything in a sketch, never fail it. |
| `comment` | `true` | Post the comment. The same text always goes to the job summary. |
| `teml-url` | `https://tools.teml.org/teml.mjs` | Where to download the `teml` command from. |
| `github-token` | `${{ github.token }}` | Token for reading the pull request and writing the comment. |

## How it works

The action compares the pull request's merge commit with its base, finds the changed files that match `files`, and runs `teml diff` and `teml check` on each. It downloads the latest `teml` command each run, so it follows the current TEML version.

- A pull request that changes no model gets no comment. If a later push removes its model changes, the comment says so.
- On a pull request from a fork, the token can't write comments; the action then leaves the changes in the job summary and doesn't fail for that reason.
- Slices are matched by name, so a renamed slice shows as one removed and one added.
- The board links carry the whole model in the part of the link after `#`, which browsers keep to themselves, so the tools.teml.org server never receives the model. Anyone who can read the comment can open them. A model too large for a link gets none.

## Development

`run.mjs` holds the logic; `node --test` runs the tests in `test/`. This repo's own pull requests run the action on `examples/`.

## License

Apache-2.0
