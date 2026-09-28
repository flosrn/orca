// eslint-disable-next-line no-control-regex -- matching ESC is the point
const DEC_PRIVATE_MODE_ONLY = /^(?:\x1b\[\?\d+(?:;\d+)*[hl])+$/

/**
 * Whether a PTY chunk is nothing but DEC private-mode set/reset sequences
 * (`ESC [ ? n[;n...] h|l`, one or more).
 *
 * Why: such a chunk is terminal housekeeping, not agent output. OMP 18.4.1 re-asserts
 * bracketed paste (`\x1b[?2004h`) every second while idle; counting it as output keeps
 * lastOutputAt fresh forever, so tui-idle quiescence never arrives and worker-start
 * never pastes its brief.
 */
export function isDecPrivateModeOnlyChunk(data: string): boolean {
  return DEC_PRIVATE_MODE_ONLY.test(data)
}
