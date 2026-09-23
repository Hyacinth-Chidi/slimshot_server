# Admin Dashboard + API Implementation Plan

## Goal

Build an authenticated admin dashboard backend for SlimShot with:

- JWT bearer authentication
- single `admin` role
- audio CRUD management
- stats / overview endpoints
- category and tag management

This document turns the agreed product plan into an implementation checklist for the current NestJS + Prisma codebase.

## Current Baseline

The project already includes:

- public audio APIs in `src/modules/audio`
- `AudioAsset` in Prisma
- Cloudinary signed upload flow
- Prisma + Neon Postgres integration

The admin implementation should extend the existing backend without breaking the public API.

## Target Scope

### Admin pages to support

- Login
- Dashboard overview
- Audio assets list
- Audio asset edit view
- Categories management
- Tags management

### Backend areas to build

- authentication module
- admin audio module
- admin stats module
- admin categories module
- admin tags module

## Phase 1: Prisma Schema

- [ ] Add `AdminUser` model
- [ ] Add `RefreshToken` model
- [ ] Add `Category` model
- [ ] Add `createdById` to `AudioAsset`
- [ ] Add `updatedById` to `AudioAsset`
- [ ] Add relations from `AudioAsset` to `AdminUser`
- [ ] Add inverse relations from `AdminUser` to `AudioAsset`
- [ ] Run Prisma migration
- [ ] Regenerate Prisma client

### Proposed models

#### `AdminUser`

- `id`
- `email`
- `passwordHash`
- `name`
- `isActive`
- `lastLoginAt`
- `createdAt`
- `updatedAt`

#### `RefreshToken`

- `id`
- `tokenHash`
- `adminUserId`
- `expiresAt`
- `createdAt`
- `revokedAt`

#### `Category`

- `id` as slug, for example `cinematic`
- `name`
- `type` using existing `AudioType`
- `sortOrder`
- `createdAt`
- `updatedAt`

#### `AudioAsset` additions

- `createdById`
- `updatedById`

## Phase 2: Auth Module

- [ ] Install auth dependencies
- [ ] Add JWT config env vars
- [ ] Create `src/modules/auth`
- [ ] Create `login` endpoint
- [ ] Create `refresh` endpoint
- [ ] Create `logout` endpoint
- [ ] Create `me` endpoint
- [ ] Add password hashing service
- [ ] Add JWT strategy
- [ ] Add auth guard
- [ ] Add current-user decorator
- [ ] Add bootstrap-first-admin logic
- [ ] Add login rate limiting

### Auth decisions

- Access token: 15 minutes
- Refresh token: 7 days
- Single role: `admin`
- Use bearer tokens, not cookie sessions

### New env vars

- [ ] `JWT_ACCESS_SECRET`
- [ ] `JWT_REFRESH_SECRET`
- [ ] `JWT_ACCESS_TTL_SECONDS`
- [ ] `JWT_REFRESH_TTL_SECONDS`
- [ ] `ADMIN_BOOTSTRAP_EMAIL`
- [ ] `ADMIN_BOOTSTRAP_PASSWORD`

## Phase 3: Admin Audio API

- [ ] Create `src/modules/admin`
- [ ] Add admin audio controller
- [ ] Add admin audio service
- [ ] Add DTOs for list, update, bulk delete, and bulk tag operations
- [ ] Reuse signed upload flow for admin upload
- [ ] Track `createdById` on create
- [ ] Track `updatedById` on update
- [ ] Add delete endpoint
- [ ] Add bulk delete endpoint
- [ ] Add bulk tag update endpoint
- [ ] Add detail endpoint

### Admin audio endpoints

- [ ] `GET /api/admin/v1/audio`
- [ ] `GET /api/admin/v1/audio/:id`
- [ ] `POST /api/admin/v1/audio/upload/sign`
- [ ] `POST /api/admin/v1/audio/upload`
- [ ] `PATCH /api/admin/v1/audio/:id`
- [ ] `DELETE /api/admin/v1/audio/:id`
- [ ] `POST /api/admin/v1/audio/bulk-delete`
- [ ] `POST /api/admin/v1/audio/bulk-tags`

### Filters and sorting

- [ ] search by title / author / filename / tags
- [ ] filter by `type`
- [ ] filter by tags
- [ ] paginate
- [ ] sort by uploaded date
- [ ] sort by title
- [ ] sort by duration
- [ ] sort by file size

## Phase 4: Stats API

- [ ] Add admin stats controller
- [ ] Add admin stats service
- [ ] Build summary query
- [ ] Build uploads-over-time query
- [ ] Build tag-usage query

### Stats endpoints

- [ ] `GET /api/admin/v1/stats/summary`
- [ ] `GET /api/admin/v1/stats/uploads-over-time`
- [ ] `GET /api/admin/v1/stats/tags-usage`

### Stats output should support

- total assets
- music count
- sfx count
- total storage bytes
- average duration
- uploads in date range
- top tags

## Phase 5: Categories API

- [ ] Add category controller
- [ ] Add category service
- [ ] Create category DTOs
- [ ] Move hardcoded categories into database
- [ ] Update public categories endpoint to read from Prisma
- [ ] Keep public categories response shape unchanged

### Category endpoints

- [ ] `GET /api/admin/v1/categories`
- [ ] `POST /api/admin/v1/categories`
- [ ] `PATCH /api/admin/v1/categories/:id`
- [ ] `DELETE /api/admin/v1/categories/:id`

## Phase 6: Tags API

- [ ] Add tags controller
- [ ] Add tags service
- [ ] Add browse tags endpoint
- [ ] Add rename tag endpoint
- [ ] Add merge tags endpoint
- [ ] Add delete unused tags endpoint
- [ ] Ensure tag updates deduplicate values
- [ ] Ensure tag operations run in transactions

### Tag endpoints

- [ ] `GET /api/admin/v1/tags`
- [ ] `POST /api/admin/v1/tags/rename`
- [ ] `POST /api/admin/v1/tags/merge`
- [ ] `DELETE /api/admin/v1/tags/unused`

## Phase 7: Shared Infrastructure

- [ ] Add shared admin response types if needed
- [ ] Add validation DTOs with `class-validator`
- [ ] Add route guards to all admin endpoints
- [ ] Add request logging for admin actions
- [ ] Add cache strategy review for mutable endpoints
- [ ] Add Cloudinary asset cleanup on delete

## Phase 8: Testing and Verification

- [ ] Verify Prisma migration applies cleanly
- [ ] Verify first admin bootstrap works
- [ ] Verify login returns access and refresh tokens
- [ ] Verify protected routes reject missing token
- [ ] Verify admin upload creates asset and tracking fields
- [ ] Verify edit updates `updatedById`
- [ ] Verify delete removes DB row
- [ ] Verify category CRUD updates public categories output
- [ ] Verify tag rename / merge behaves correctly
- [ ] Verify stats endpoints return correct aggregates

## Suggested Build Order

1. Prisma schema and migration
2. Auth module
3. Admin stats module
4. Categories module and public category refactor
5. Admin audio CRUD
6. Tags module
7. Cleanup, verification, and docs updates

## File / Module Plan

### New modules

- `src/modules/auth`
- `src/modules/admin`

### Likely files

- `src/modules/auth/auth.module.ts`
- `src/modules/auth/auth.controller.ts`
- `src/modules/auth/auth.service.ts`
- `src/modules/auth/password.service.ts`
- `src/modules/auth/dto/login.dto.ts`
- `src/modules/auth/dto/refresh-token.dto.ts`
- `src/modules/admin/admin.module.ts`
- `src/modules/admin/admin-audio.controller.ts`
- `src/modules/admin/admin-audio.service.ts`
- `src/modules/admin/admin-stats.controller.ts`
- `src/modules/admin/admin-stats.service.ts`
- `src/modules/admin/admin-categories.controller.ts`
- `src/modules/admin/admin-categories.service.ts`
- `src/modules/admin/admin-tags.controller.ts`
- `src/modules/admin/admin-tags.service.ts`

### Shared auth helpers

- `src/common/guards/jwt-auth.guard.ts`
- `src/common/strategies/jwt.strategy.ts`
- `src/common/decorators/current-user.decorator.ts`

## Acceptance Criteria

- [ ] Admin can log in and receive JWT tokens
- [ ] All admin routes require a valid bearer token
- [ ] Admin can list, view, upload, edit, and delete audio assets
- [ ] Admin can view dashboard statistics
- [ ] Admin can manage categories in the database
- [ ] Public categories endpoint uses database-backed categories
- [ ] Admin can browse, rename, and merge tags
- [ ] Changes are validated and stored via Prisma
- [ ] Existing public audio search remains functional

## Notes

- Keep the public API under `/api/v1/audio` stable while adding admin APIs under `/api/admin/v1`.
- Prefer extending existing audio upload logic instead of duplicating Cloudinary behavior.
- Keep response envelopes consistent with the current backend style.
