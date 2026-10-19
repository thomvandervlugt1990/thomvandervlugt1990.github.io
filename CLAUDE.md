# CLAUDE.md

Personal website hosted on GitHub Pages (https://thomvandervlugt1990.github.io).
Plain HTML pages with one shared stylesheet (`styles.css`). No build step.

## Way of working

1. **Branch:** never work directly on `main`. Start each change on a new branch
   from an up-to-date `main` (e.g. `git switch main && git pull && git switch -c <short-name>`).
2. **Make the changes** and briefly explain what each changed file does.
3. **Commit** with a clear message describing the change.
4. **Push** the branch to `origin`.
5. **Open a pull request** into `main` with `gh pr create`, with a short summary
   of what changed and why.
6. **Stop there.** The owner reviews and merges the pull request on GitHub.
   Never merge pull requests, push to `main`, or force-push.

GitHub Pages publishes from `main`, so the live site only changes after a merge.

## Agents and models

The main session runs on **Opus** and acts as the director:

- **Plan:** Opus breaks the task into clear pieces and decides who does what.
- **Delegate:** hand off pieces to subagents on cheaper models, with a clear brief
  (what to do, which files, what "done" looks like):
  - **Haiku:** searching and reading (Explore agent), simple mechanical edits.
  - **Sonnet:** building pages, writing HTML/CSS, normal edits.
  - Small tasks Opus can finish quickly itself don't need delegating.
- **Check:** when a subagent finishes, Opus reviews everything it changed before
  moving on: reads the diff, checks it against the brief and the site conventions
  below, and fixes or sends back anything wrong. Never pass on a subagent's
  "done" without checking it.
- **Report:** only after Opus has checked the work does it commit, push and open the
  pull request, and say which parts were delegated and what was corrected.

## Site conventions

- Every page links `styles.css`; don't add page-specific stylesheets or inline styles.
- Keep the same header (logo + nav) and footer on every page. When adding a page,
  add it to the nav on all pages and set `aria-current="page"` on its own link.
- Colours and spacing live as CSS variables in `:root`, with a dark-mode override.
  Use those variables instead of hard-coded colours.
- Must work well on phones: check layouts at narrow widths (~360px).
