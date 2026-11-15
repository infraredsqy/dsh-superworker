/**
 * The first sentence the panel's setup action hands a new session.
 *
 * A workspace whose records name no session the panel can draw — a fresh clone, one just
 * initialised, one whose records hold no node yet — gets one way forward on the stage: an agent
 * reads the workspace and draws the pipeline's first node. That agent arrives already knowing what
 * it is being asked to do, and the asking is a fixed sentence rather than one composed from the
 * workspace: a composed prompt would be a second place that spells what the pipeline is for. The
 * door itself is the host half's (`consultSetup`); the words are the engine's, so no client keeps
 * a copy that can drift.
 */
export const SETUP_PROMPT =
  '/sw-route 这个工作区还没有接入管道。请先读取这个工作区，把要做的事按 sw-route 的方式连成图，并加入第一个节点。';
