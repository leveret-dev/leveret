# Leveret — agent notes

## Code Review Rules

Every review bot (Codex reads this section natively) applies these rules to a pull request:

- **Do not review:** `**/*.md` (including `docs/**` and `DESIGN.md`), `.serena/**`,
  benchmark fixtures and results (`bench/results/**`, `bench/work-items/**`, `bench/*.json`),
  `package-lock.json`, `inspect/gradle/wrapper/**`, and generated output (`dist/**`,
  `**/build/**`, `graphify-out/**`, `.codegraph/**`).
- **Read docs on demand only:** open `README.md` or `DESIGN.md` only when a changed line
  depends on a documented contract; never comment on documentation outside the diff.
- **Focus** on `src/**`, `test/**`, `tests/shell/**`, `inspect/**` (Kotlin), `bench/*.mts`,
  `scripts/**`, and `.githooks/**`:
  - **Correctness:** unhandled edge cases, null/type errors, off-by-one errors, races,
    resource leaks, unhandled promise rejections, and broken control flow.
  - **Security:** the reviewed checkout is hostile input. Flag path traversal, command
    injection, unescaped shell arguments, webhook signature or token-scope gaps, and any
    path that lets the reviewed checkout's settings, hooks, skills, or context extend the
    runner session.
  - **Privacy invariants:** the engine layer never calls an LLM; provider credentials and
    reviewed-checkout content never reach Leveret-operated infrastructure; raw content
    never enters default stdout.
  - **Test integrity:** tests assert observable behavior and fail on regression; flag
    coverage theater and vacuous assertions.
  - **Shell:** scripts are POSIX `sh`; flag bash-isms.
  - **Noise:** do not flag formatting, whitespace, import order, or style choices.
