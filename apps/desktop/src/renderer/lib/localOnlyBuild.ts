/**
 * LOCAL_ONLY_BUILD — single switch for runs that must never talk to Cindy cloud.
 *
 * When true:
 *   - /login and /add-account are unreachable (redirect to home)
 *   - every "Sign in to Cindy" CTA is not rendered (onboarding cards, banner,
 *     settings provider pane, sidebar account menu)
 *   - the Cindy AI sign-in pseudo-row is hidden from Settings → Providers
 *
 * The auth/cloud code paths are intentionally kept intact: flip this to false
 * once a self-hosted server and its auth flow are wired up.
 */
export const LOCAL_ONLY_BUILD = true;
