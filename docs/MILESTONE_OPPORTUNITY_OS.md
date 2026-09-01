# Radar milestone: Opportunity OS

This milestone turns Radar from an opportunity feed into an opportunity operating system. The frontend direction is derived from the September 2026 Drive design pack and is backed by explicit server and database contracts rather than static cards.

## Product lifecycle

`discover -> assess -> decide -> prepare -> collaborate -> submit -> track -> learn`

## Implemented surfaces

- Discovery feed with profile-aware fit ranking, category/location/remote filters and opportunity detail.
- Opportunity workspaces created from a live opportunity.
- Required-document packages seeded by opportunity type.
- Workspace progress, stages and submission readiness.
- Local Radar AI preparation plans.
- Local Radar AI document drafting/autofill with grounded evidence constraints.
- Local Radar AI document review for coverage, unsupported claims, gaps and readiness.
- Reusable "Golden Documents" library for CVs, bios, capability statements, references and evidence.
- Team workspace members, comments, comment resolution and AI review summaries.
- Notifications for workspace and submission milestones.
- Application pipeline and performance analytics.
- Contextual Radar AI assistant scoped to a selected opportunity or workspace.
- Existing Tuku Core SSO, profile/CV extraction, saved opportunities, fit explanation and daily brief retained.

## Local AI contract

Radar continues to call the shared Tuku Core AI integration. The server now uses the supported `analyze`, `extract`, `summarize`, `recommend`, `draft`, and `explain` capabilities. Long drafting/review tasks request background mode; interactive explanation/chat stays interactive.

All preparation prompts follow these rules:

1. Use supplied profile, opportunity, workspace and reusable-document facts only.
2. Never invent credentials, partners, team members, budgets, certifications, references, dates or eligibility.
3. Missing evidence is emitted as `[NEEDS INPUT: ...]` rather than fabricated.
4. AI may recommend and prepare; it does not claim to perform external submission.
5. Radar records a submission only after explicit user confirmation, and the response makes clear that this is a tracking action rather than an external portal action.

## New persistence contracts

- `OpportunityWorkspace`
- `WorkspaceDocument`
- `WorkspaceMember`
- `WorkspaceComment`
- `UserDocument`
- `Notification`

These are additive to the existing `User`, `Opportunity`, `Application`, `SavedOpportunity`, `Match`, `Alert`, `Payment` and session models.

## New API contracts

### Workspaces

- `GET /api/me/workspaces`
- `POST /api/opportunities/:id/workspace`
- `GET /api/workspaces/:id`
- `PATCH /api/workspaces/:id`
- `POST /api/workspaces/:id/ai/plan`
- `POST /api/workspaces/:id/finalize`
- `POST /api/workspaces/:id/submit`

### Workspace documents

- `PATCH /api/workspaces/:id/documents/:documentId`
- `POST /api/workspaces/:id/documents/:documentId/ai-draft`
- `POST /api/workspaces/:id/documents/:documentId/ai-review`

### Collaboration

- `GET /api/workspaces/:id/comments`
- `POST /api/workspaces/:id/comments`
- `PATCH /api/workspaces/:id/comments/:commentId`
- `POST /api/workspaces/:id/members`
- `POST /api/workspaces/:id/ai/team-summary`

### Reusable documents

- `GET /api/me/documents`
- `GET /api/me/documents/:id`
- `POST /api/me/documents`
- `PATCH /api/me/documents/:id`
- `DELETE /api/me/documents/:id`

### Intelligence and reporting

- `POST /api/ai/chat`
- `GET /api/me/analytics`
- `GET /api/me/subscription`
- `GET /api/me/notifications`
- `PATCH /api/me/notifications/:id/read`
- `POST /api/me/notifications/read-all`

## Deployment requirement

The production Docker image runs `server/index.mjs` directly. Because this milestone adds Prisma models, apply the schema before restarting the new application image:

```bash
npm run prisma:deploy
```

The current package script maps this to `prisma db push`.

Recommended deployment order:

1. Back up the Radar PostgreSQL database.
2. Build the new image / pull the merged source.
3. Run `npm run prisma:deploy` against the Radar database.
4. Start/restart the Radar API and scheduler containers.
5. Check `/ready` and confirm `database: "ok"`, `aiConfigured: true`, and `milestone: "opportunity-os"`.
6. Smoke-test Tuku SSO, one workspace creation, one AI plan, one document draft/review, Golden Documents, and application tracking.

## Verification performed before PR

- Browser JavaScript syntax checked with `node --check`.
- Server JavaScript syntax checked with `node --check`.
- Branch compared against `main`; changes are isolated to the milestone files plus this document.
- No GitHub Actions workflow currently exists in the repository, so there is no repository CI build to rely on for Prisma validation or integration tests.

## Next contracts after this milestone

The Drive pack also points toward deeper subscription enforcement, real invitation delivery, richer version-history objects, structured opportunity value/currency fields, organisation-wide workspaces, external submission connectors where allowed, and learning loops from application outcomes. Those should build on these contracts rather than introduce another frontend/backend stack.
