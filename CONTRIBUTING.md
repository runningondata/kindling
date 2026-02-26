# Contributing to Kindling

Thanks for your interest in contributing! Here's how to get started.

## Development setup

```bash
git clone https://github.com/allyreilly/kindling.git
cd kindling
npm install
npm run build
```

Load the extension in Chrome: open `chrome://extensions/`, enable Developer mode, click **Load unpacked**, and select the `extension/` directory.

Use `npm run watch` for live rebuilds during development.

## Running tests

```bash
npm test            # Unit tests
npm run lint        # ESLint
npm run test:e2e    # E2E tests (requires Java 17+, uv)
```

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes in `src/` — the `extension/` directory contains build output
3. Add tests for new functionality
4. Ensure `npm test` and `npm run lint` pass
5. Submit a pull request

## Pull request process

- PRs require CI to pass and at least one approval
- Use a clear title describing the change
- Link any related issues
- Keep changes focused — one concern per PR

## Code style

- ESLint enforces style (`no-var`, `prefer-const`, `eqeqeq`)
- Run `npm run lint` before submitting
- Follow existing patterns in the codebase

## Reporting bugs

Use the [bug report template](https://github.com/allyreilly/kindling/issues/new?template=bug_report.md) on GitHub Issues.

## License

By contributing, you agree that your contributions will be licensed under the same terms as the project (see [LICENSE](LICENSE)).
