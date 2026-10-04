# Agent Review contributor guidelines

## UX: GitHub and Primer

All user-facing UX must follow GitHub's style, theme, and color guidelines.
Use [GitHub Primer](https://primer.style/) as the reference, not a custom brand
palette or a generic AI-dashboard aesthetic.

- Use the shared semantic theme tokens in the extension stylesheet. Match
  GitHub's neutral surfaces, borders, text, blue links/focus, and green primary
  actions in both light and dark modes.
- Reserve semantic color for status and evidence: additions/success, deletions/
  danger, warnings, and selected states. Do not tint entire summary panels or
  use decorative rose/purple accents.
- Reuse consistent controls, restrained radii, typography, spacing, dialogs,
  and list treatments. New features must look native to the existing UI.
- Keep review content concise, distinguish AI interpretation from evidence,
  expose loading/errors, and clearly identify the reviewed repository/target.
- Interactively verify the actual application with real repository data.
  Check light/dark themes, narrow layouts, keyboard focus, and every affected
  interaction. Inspect screenshots as well as automated assertions.

Do not declare UX work complete based on unit tests or fixture screenshots alone.
