# sw-issue-discuss Anti-patterns

Check before starting. The full rules live in [`./SKILL.md`](./SKILL.md); this page lists symptoms and correction signals only.

## `issue-discuss-batch-over-decision-quota` — Exceeding the 4-decision batch cap

**Symptom**: Presenting a dozen `external` entries at once and asking "fix or not? A or B?" for each.

**Correction signal**: The user starts replying "you decide", or a batch contains five or more decisions.

## `issue-discuss-submits-unreviewed-externals` — Presenting unreviewed `external` entries

**Symptom**: Passing every `external` entry straight to the user—for example, 12 of 20 entries already have a concrete fix in `suggestion`.

**Correction signal**: You have not checked whether the first entry presented actually involves a trade-off.

## `issue-discuss-details-instead-of-tradeoffs` — Dumping implementation details instead of trade-offs

**Symptom**: Presenting function names, variable names, line numbers, or call chains and forcing the user to extract the decision point from code details.

**Correction signal**: The user asks "so what exactly am I deciding?".

## `issue-discuss-reason-records-discussed-only` — Recording "discussed" instead of the decision in `--reason`

**Symptom**: The user decides "report errors uniformly", but `--reason` only records "discussed".

**Correction signal**: A downstream executor reading `--reason` cannot tell what the user actually decided.
