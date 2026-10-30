---
extends: refactoring
when: A behavior-preserving change to structure, a simplification, a rename or move, a dependency-boundary cleanup, or a migration off an old API or schema.
---
- **In** "Pin the behavior contract first.": Apply the **code-simplification** skill: the Chesterton's Fence check before anything moves, one simplification per test run, and existing tests pass without modification. Above roughly 500 lines of mechanical change, write a codemod (the **build-the-lever** principle) instead of editing by hand.
- **In** "Name the target shape.": Use the vocabulary and the deletion test in the **codebase-design** skill. For a whole-codebase scan of deepening candidates, run the **improve-codebase-architecture** skill. For TypeScript package boundaries, the **setup-ts-deep-modules** skill wires dependency-cruiser rules that prove the boundary bites. Tests that lean on `as` casts migrate per the **migrate-to-shoehorn** skill.
- **In** "Move in small behavior-preserving steps": An internal API migrates every caller and deletes the old one in this wave, as the step says. A stored format, a schema, or an API with external consumers is the exception: it changes through expand and contract per the **deprecation-and-migration** skill, with a tested down path, and the contract step is its own follow-up once every consumer has moved.
