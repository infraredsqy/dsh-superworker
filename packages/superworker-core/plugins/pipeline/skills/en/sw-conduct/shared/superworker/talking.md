# Talking to a person

> This page is about one thing: what crosses over when the agent hands words to a person. Close-time reports, a stop that needs a call, talking a request through with the user, putting one piece of debt on the table — all of it follows this.
> Text whose reader is a session (reports, prompts, `run.md`, the handoff ticket) lives elsewhere — there, coordinates and readings are exactly what is wanted.

## 1. Report one tangle

**The agent does the synthesising; the person does the judging.** Facts scattered through the code only become one thing once they are put together, and that putting-together is the agent's work — do not pull the person in to help.

| | In units of the tangle — right | In units of the sighting — wrong |
|---|---|---|
| What it says | The same thing is written twice; each side keeps half the record, the order they land in is up for grabs, and a reader can catch it with only half written | This logic appears once in A and once in B; A is this, B is that; a wire ties the two together |
| What the listener does first | Judges it | Rebuilds both sides in their head, then judges |

Reporting sightings alone is the search result copied out as it came; it reads as detail and does none of the work. The tangle is the sentence that survives the synthesising. If a piece of work will not fold into one sentence, it is not ready to be called on yet — finish putting it together before you speak, rather than carrying the raw material to the table.

## 2. Every item carries four lines

What you put on the table is one tangle, one at a time. Four lines, and a line left out is content left unsaid:

| Line | What it says |
|---|---|
| **The tangle** | One sentence: what is wrong |
| **What happens if it stays** | Under what conditions it goes wrong, in what shape, and how long before anyone notices |
| **The roads** | What each one costs: how big the change is, what it leaves behind |
| **What I would take** | Which road, and why |

**The floor**: no coordinates in the sentence — no files, no line numbers, no identifier spelled out as written, no call chain.

**The ceiling**: the listener can build a "when does it go wrong" scene out of that sentence. If they cannot, it is empty air ("these two parts are a bit coupled and want tidying up" is all Chinese and says nothing) — say it again.

## 3. How a concept name turns up

`config get answer` reads this setting; two values:

| Setting | The concept name |
|---|---|
| `technical` | The shortest word, straight out: "whether this becomes event-driven is your call" |
| `plain` (default) | The same word, then one sentence unfolding it: "someone else tells you it happened, instead of you asking every so often" |

**Both values carry the same amount**: the tangle, the roads, what each costs, a recommendation — all four lines. The only difference is whether that word gets a sentence unfolding it. Adding the sentence gives one more line at the same place; it does not trim anything back.

No coordinates either way. `technical` saves that one unfolding sentence and nothing else.

The setting applies where the reader is a person; in a fully automatic run there is no reader and it goes unused. When he says "I know that word, skip the explanation", give this one in `technical`; when it keeps happening, make it a setting: `config set answer technical --global`.

## 4. Before you open your mouth

| Where the answer is | What the question looks like | What to do |
|---|---|---|
| Only in his head | Which experience is wanted, whether it is worth it, what runs first, how much cost is acceptable | Ask; ask it once and completely, with the options and their prices |
| In my hands | What it is called, which file it goes in, which step comes first | Decide it, and write it into the autopilot decision list of `run.md` |
| Nobody has it | A number only a measurement gives, a fact only reading the code gives | Dispatch a subagent to measure or read |

Stopping for a person takes both at once: the answer sits only with him, and going on is impossible without it. With one of the two missing, that stop is a hole dug for yourself.

## 5. The close-time report

This pass, reported to a person, three things in this order:

1. **What was delivered**: one sentence
2. **What tangle is still open**: say so when there is none
3. **What call is needed**: the one thing he can settle; when he cannot, say what is still missing

A technical report a subagent hands back is put through these three before it is reported — never forwarded whole.
