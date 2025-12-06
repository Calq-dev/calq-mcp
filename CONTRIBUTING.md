# Contributing to Calq MCP

Thank you for your interest in contributing to Calq! This document outlines our Git workflow and contribution guidelines.

## Git Flow

We use a simplified Git Flow with the following branches:

```
main (production)
  └── develop (integration)
        ├── feature/xxx (new features)
        ├── fix/xxx (bug fixes)
        └── docs/xxx (documentation)
```

### Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feature/short-description` | `feature/export-csv` |
| Bug fix | `fix/short-description` | `fix/timer-overflow` |
| Documentation | `docs/short-description` | `docs/api-reference` |
| Hotfix | `hotfix/short-description` | `hotfix/auth-crash` |

### Workflow

1. **Create a branch** from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature
   ```

2. **Make commits** with clear messages:
   ```bash
   git commit -m "feat: add CSV export for time entries"
   git commit -m "fix: handle empty project list"
   git commit -m "docs: update README with new tools"
   ```

3. **Push and create PR**:
   ```bash
   git push origin feature/your-feature
   ```
   Then create a Pull Request to `develop`.

4. **After review**, merge to `develop`.

5. **Release**: Merge `develop` to `main` for production releases.

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance

Examples:
```
feat: add semantic search for time entries
fix: prevent duplicate timer starts
docs: add OAuth setup instructions
refactor: extract user validation to auth module
```

## Development Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/calq-mcp.git
   cd calq-mcp
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create `.env` from `.env.example` and fill in your keys
5. Run locally:
   ```bash
   npm start
   ```

## Pull Request Guidelines

- Keep PRs focused on a single feature or fix
- Update documentation if adding new features
- Ensure no syntax errors: `node --check src/index.js`
- Test your changes locally with Claude Desktop/Code

## Code Style

- Use ES modules (`import`/`export`)
- Use async/await for asynchronous code
- Add JSDoc comments for functions
- Keep functions focused and small

## Questions?

Open an issue for questions or discussions.
