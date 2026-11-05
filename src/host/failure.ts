/**
 * Why a pathfinder operation was refused, as a code rather than a sentence.
 *
 * The host half cannot know which language the reader is looking at: the panel's language is a
 * browser-side fact, decided in the browser and stored in the Host's settings document, and a host
 * method is called per request without one. So a refusal crosses the boundary as a code, and the
 * panel spells the sentence (`src/client/words.ts`).
 *
 * `detail` carries what no dictionary on this side owns: the offending argument, the name of what
 * is missing, or another program's own output. A refusal whose words come from a program we do not
 * own says so by carrying them here rather than inventing a translation for them.
 */

/** Every reason this half can refuse an operation. */
export type PfRefusalCode =
  /** An argument cannot address a record: the segment gate in `executor.ts` refused it. */
  | 'arg-not-allowed'
  /** The words layer answered non-zero; `detail` is its own output. */
  | 'tool-refused'
  /** An instruction scope outside the three the tool spells. */
  | 'scope-unknown'
  /** An empty verbatim sentence: nothing to record. */
  | 'empty-text'
  /** The host exposes no session side for a native open; `detail` names the missing piece (`sessions` / `agents`). */
  | 'no-session-service'
  /** The plan's launch prompt for this cell is not in the record store (or holds no line). */
  | 'prompt-missing'
  /** The open did not complete; `detail` carries what went wrong, verbatim. */
  | 'open-failed'
  /** The dispatch path refused — the engine's gates, preparation or the opener inside it said no; `detail` carries its reason, verbatim. */
  | 'dispatch-refused'

/** A refusal: which one, plus the untranslatable detail that goes with it. */
export interface PfRefusal {
  readonly code: PfRefusalCode
  readonly detail?: string
}

/**
 * What a write returns.
 *
 * On success `text` is the words layer's own output, carried out verbatim: those are its words, not
 * this plugin's, and the config reader parses exactly this stream. On failure the reason is a code,
 * with the words layer's own words — when it said any — in `detail`.
 */
export type PfOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: PfRefusalCode; readonly detail?: string }

/** The failure branch of an outcome, named so a launcher can return it before an outcome exists. */
export type PfFailure = Extract<PfOutcome, { readonly ok: false }>

/**
 * Why installing the shipped plugin skills was refused, as a code rather than a sentence.
 *
 * This is a second vocabulary, deliberately not part of {@link PfRefusalCode}: that one is what the
 * panel spells, and it is decided while answering a request from a browser. Skills are placed once,
 * when the line loads, before any request exists — nobody reads these codes in a language of their
 * choosing, so they never reach the panel's word tables. What they must be is decidable: a caller
 * (or a log reader) can tell which of the facts went wrong without reading prose.
 *
 * `detail` carries the names this half does not own: the plugins and skill names the engine reported,
 * the resolved paths, the two places a shadowed skill was found in.
 */
export type PfSkillRefusalCode =
  /** The host exposes no skills service, so the session's own catalog view cannot be read. */
  | 'no-skill-registry'
  /** The package's own plugin directory yields no plugin at all — the skills it should ship are not there. */
  | 'skills-missing'
  /** One skill name is shipped by two plugins (the engine's `skillProblems` refuses the set). */
  | 'skill-conflict'
  /** A shipped `SKILL.md` cannot be read as a skill, or does not carry the name its folder declares. */
  | 'skill-unreadable'
  /** The skill could not be written into the skill root; `detail` names the file and what the filesystem said. */
  | 'skill-place-failed'
  /** The winning entry for a name, in the view that was read, is not the copy this line placed. */
  | 'skill-shadowed'
  /** The catalog could not be read, so the view's winners cannot be judged. */
  | 'catalog-unreadable'
  /** The record of what this line placed before cannot be read, so nothing is overwritten or taken back. */
  | 'manifest-unreadable'

/** A skill-install refusal: which one, plus the names and paths that go with it. */
export interface PfSkillRefusal {
  readonly ok: false
  readonly code: PfSkillRefusalCode
  readonly detail: string
}

/**
 * What placing the shipped plugin skills hands back.
 *
 * The outcome says what was **placed**, never what a session sees: placing happens before any
 * session exists, so the only evidence this half can honestly carry is the skill root it wrote and
 * the manifest naming every file it wrote there. Whether the placed copy wins a name in a session's
 * own view is a separate reading ({@link PfSkillViewOutcome}), taken where a workspace is known.
 *
 * On refusal `detail` names what went wrong; a refusal leaves nothing placed by this attempt, so the
 * caller has no half state to reason about.
 */
export type PfSkillsOutcome =
  | {
      readonly ok: true
      readonly names: readonly string[]
      /** The skill root the skills were placed in (`<dshHome>/skills`). */
      readonly root: string
      /** The manifest recording exactly what was placed, so unloading takes back only that. */
      readonly manifest: string
    }
  | PfSkillRefusal

/**
 * What one session-view diagnostic read of the placed skills returns.
 *
 * A view is a workspace's skill catalog as a session reads it (`list({ cwd, scope })`); the same
 * read a session's own catalog does. A refusal here is the diagnostic's finding, not a verdict on
 * the placement. An empty `names` means this line has nothing placed, so there is nothing to read
 * back — an empty outcome is not a claim of victory.
 */
export type PfSkillViewOutcome =
  | { readonly ok: true; readonly names: readonly string[] }
  | PfSkillRefusal