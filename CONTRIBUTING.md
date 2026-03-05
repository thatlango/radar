# Contributing to Radar

Thank you for your interest in contributing to Radar! This document provides guidelines and instructions for contributing.

## 🤝 How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/YOUR_USERNAME/radar/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots if applicable
   - System information (OS, Node version, etc.)

### Suggesting Features

1. Search existing [Issues](https://github.com/YOUR_USERNAME/radar/issues) for similar suggestions
2. Create a new issue with:
   - Clear use case
   - Proposed solution
   - Why this benefits users
   - Any relevant examples

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Write/update tests if applicable
5. Run tests and linters (`npm test && npm run lint`)
6. Commit with clear messages (`git commit -m 'Add: feature description'`)
7. Push to your fork (`git push origin feature/your-feature`)
8. Open a Pull Request

## 📋 Development Guidelines

### Code Style

- Follow existing code patterns
- Use TypeScript for type safety
- Write meaningful variable and function names
- Add comments for complex logic

### Commit Messages

Use conventional commits:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting)
- `refactor:` Code refactoring
- `test:` Test additions/changes
- `chore:` Maintenance tasks

Examples:
```
feat: add SMS alert functionality
fix: resolve scraper timeout issue
docs: update deployment instructions
```

### Testing

- Write unit tests for new features
- Ensure all tests pass before submitting PR
- Aim for >80% code coverage

### Documentation

- Update README.md if adding user-facing features
- Update DEPLOYMENT.md if changing infrastructure
- Add inline comments for complex logic
- Update API documentation if modifying endpoints

## 🏗️ Project Structure

```
radar/
├── ai/           # AI/ML logic
├── alerts/       # Notification system
├── scrapers/     # Data collection
├── payments/     # Payment processing
├── prisma/       # Database schema
└── tests/        # Test suites
```

## 🧪 Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test
npm test -- scrapers/BaseScraper.test.ts
```

## 🔍 Code Review Process

1. PRs require at least one approval
2. All CI checks must pass
3. Code must follow style guidelines
4. Tests must be included for new features
5. Documentation must be updated

## 📞 Getting Help

- **Questions**: Open a [Discussion](https://github.com/YOUR_USERNAME/radar/discussions)
- **Bugs**: Open an [Issue](https://github.com/YOUR_USERNAME/radar/issues)
- **Email**: hello@tuku-tuku.com

## 📄 License

By contributing, you agree that your contributions will be licensed under the project's Proprietary License.

---

Thank you for helping make Radar better! 🎯
