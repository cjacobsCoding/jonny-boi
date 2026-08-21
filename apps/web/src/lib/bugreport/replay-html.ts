/**
 * `replay.html` — the clip, as a page you can just open.
 *
 * A bug report is read on someone else's machine, often days later, sometimes
 * with no network. So the replay ships as ONE self-contained file: the player
 * and its stylesheet are inlined, the events are inlined, and nothing is fetched
 * from anywhere. Double-click it and the last thirty seconds play back with a
 * scrubber.
 *
 * (The page the clip replays may itself reference remote card art. Those images
 * are the app's own https URLs and will load if there is a network and show as
 * gaps if there is not — which is a graceful degradation of the picture, not of
 * the replay. Inlining them would multiply every report's size by the size of
 * every image on screen.)
 *
 * PURE. It takes strings and returns a string, so what it produces is pinned by
 * tests rather than inspected by hand once and trusted.
 */

export interface ReplayPageInput {
  /** The rrweb-player UMD bundle source. */
  readonly playerJs: string;
  /** The player's stylesheet. */
  readonly playerCss: string;
  /** The recorded events, already JSON. */
  readonly eventsJson: string;
  /** For the header: when it was filed and what was on screen. */
  readonly title: string;
  readonly subtitle: string;
}

/**
 * `</script>` inside a JSON string would end the script element early — the
 * classic way an inlined payload breaks a page. Escaping the sequence keeps the
 * JSON valid to a parser while making it inert to the HTML tokeniser.
 */
export function escapeForScript(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** Minimal HTML escaping for the header text. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildReplayHtml(input: ReplayPageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>
${input.playerCss}
body { margin: 0; background: #0f1419; color: #e8eaf0;
  font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
header { padding: 12px 16px; border-bottom: 1px solid #2a3038; }
h1 { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
p { margin: 0; font-size: 13px; color: #9aa2b1; }
main { padding: 16px; }
#fallback { padding: 16px; font-size: 14px; color: #e88; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(input.title)}</h1>
  <p>${escapeHtml(input.subtitle)}</p>
</header>
<main id="player"></main>
<div id="fallback" hidden></div>
<script>${input.playerJs}</script>
<script>
const events = ${escapeForScript(input.eventsJson)};
// The player is handed a fixed width so the replay is not squeezed by this
// page's own layout; it scales the recorded viewport to fit.
try {
  if (!Array.isArray(events) || events.length < 2) {
    throw new Error('the clip carries ' + (Array.isArray(events) ? events.length : 0) + ' event(s)');
  }
  const Player = window.rrwebPlayer && (window.rrwebPlayer.default || window.rrwebPlayer);
  if (typeof Player !== 'function') throw new Error('the bundled player did not load');
  new Player({
    target: document.getElementById('player'),
    props: { events, width: Math.min(1280, window.innerWidth - 32), autoPlay: false, showController: true },
  });
} catch (error) {
  // Say what went wrong IN THE PAGE. A blank replay that fails silently is
  // indistinguishable from a clip that recorded nothing.
  const fallback = document.getElementById('fallback');
  fallback.hidden = false;
  fallback.textContent = 'This clip could not be played: ' + (error && error.message ? error.message : String(error))
    + ' — clip.json in this report holds the raw events.';
}
</script>
</body>
</html>
`;
}
