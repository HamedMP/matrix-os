# Spec: Group Manager App (Phase 7c)

**Created**: 2026-04-12
**Status**: Draft
**Parent**: 062-shared-apps
**Depends on**: Phase 7b (T101-T117 shell UI)

## Problem

Group management is scattered across tiny UI fragments: a dropdown to switch groups, a hidden share button in the title bar, no way to see all your groups and their apps at a glance, no admin controls. Users who create groups have no way to rename them, manage members, generate invite links, or see which apps are shared. The current UX requires knowing where to look for each action.

## Solution

A dedicated **Groups** app — a first-class window that opens from the dock (like Settings or Terminal). It's the single place for everything group-related: browsing groups, managing members, sharing apps, and admin controls.

## User Stories

### US1: Group Dashboard
As a user, I want to see all my groups in one place with their shared apps, so I can quickly navigate and understand my collaborative spaces.

### US2: Group Admin
As a group creator/owner, I want to rename the group, change its avatar, and configure settings from a proper admin panel.

### US3: Member Management
As a group owner, I want to invite members by handle, generate a shareable join link, change member roles, and remove members — all from a clear member list.

### US4: App Management
As a group owner, I want to see which apps are shared to a group, share new ones, and unshare existing ones — with a visual picker, not a hidden title bar button.

### US5: Group Discovery
As a user, I want to join a group via a link or room ID, without needing the terminal.

## Design

### Layout

The Groups app is a single-page app rendered in a standard Matrix OS window. It uses a two-panel layout:

```
+-------------------+----------------------------------+
| Groups List       | Group Detail                     |
|                   |                                  |
| [+ New Group]     | Group Name          [Edit] [Del] |
|                   |                                  |
| * Family     (3)  | ---- Members (3) ----            |
|   Work       (2)  | @alice  owner  [role v]          |
|   Book Club  (1)  | @bob    editor [role v] [x]      |
|                   | @carol  viewer [role v] [x]      |
|                   | [Invite member...]                |
|                   | [Copy invite link]                |
|                   |                                  |
|                   | ---- Shared Apps (2) ----         |
|                   | [notes icon] Notes    [unshare]  |
|                   | [todo icon]  Todo     [unshare]  |
|                   | [+ Share an app...]               |
|                   |                                  |
|                   | ---- Settings ----                |
|                   | [Leave group]                    |
+-------------------+----------------------------------+
```

### Left Panel: Groups List
- All groups the user belongs to, sorted by last activity
- Each row shows: group name, member count badge, unread indicator (future)
- "New Group" button at top opens create dialog
- Clicking a group selects it in the right panel
- Active group highlighted

### Right Panel: Group Detail

**Header**:
- Group name (editable inline for owners)
- Owner badge if you created it
- Delete group button (owner only, with confirmation)

**Members Section**:
- List of members with: avatar placeholder, handle, role badge (owner/editor/viewer), membership status (invited/joined)
- Owner sees:
  - Role dropdown per member (change PL via Matrix)
  - Remove button per non-owner member
  - Invite input (handle field + invite button)
  - "Copy invite link" button (generates a `matrix-os.com/join/ROOM_ID` URL or copies room_id)
- Non-owners see read-only member list

**Shared Apps Section**:
- Grid/list of apps shared to this group
- Each shows: app icon, name, who shared it (future)
- Owner sees:
  - "Unshare" button per app (removes from group's apps/ dir)
  - "Share an app" button that opens a picker showing personal apps not yet shared to this group
- Non-owners see read-only app list, can click to open

**Settings Section**:
- "Leave group" button (with confirmation)
- Owner: "Delete group" (archives for all members)

### Empty States
- No groups: Icon + "Create your first group to collaborate with others" + CTA button
- No members (impossible but): "Invite someone to get started"
- No shared apps: "Share an app from your personal workspace" + CTA button
- Selected group but loading: Skeleton UI

## Gateway Routes Needed

### Existing (from Phase 7b)
- `GET /api/groups` — list all groups
- `POST /api/groups` — create group
- `GET /api/groups/:slug/members` — list members
- `POST /api/groups/:slug/invite` — invite member
- `GET /api/groups/:slug/apps` — list shared apps (now with entry field)
- `POST /api/groups/:slug/share-app` — share app to group
- `POST /api/groups/:slug/leave` — leave group

### New Routes
- `PATCH /api/groups/:slug` — rename group (owner only, updates `m.room.name`)
  - Body: `{ name: string }`
  - Auth: caller PL >= 50 (state_default)
  - Updates both Matrix room name and local manifest

- `DELETE /api/groups/:slug/apps/:app` — unshare app (owner only)
  - Removes `~/groups/{slug}/apps/{app}/` directory
  - Removes `m.matrix_os.app_acl` state event
  - Auth: caller PL >= 100

- `PATCH /api/groups/:slug/members/:handle/role` — change member role
  - Body: `{ role: "owner" | "editor" | "viewer" }`
  - Maps to PL: owner=100, editor=50, viewer=0
  - Auth: caller PL >= target PL (can't elevate above self)
  - Calls `matrixClient.setPowerLevels`

- `POST /api/groups/:slug/kick` — remove member
  - Body: `{ user_id: string }`
  - Auth: caller PL >= kick PL (default 50)
  - Calls `matrixClient.kickFromRoom`

- `GET /api/apps` — list personal apps (for the share picker)
  - Returns `{ apps: [{ slug, name, icon? }] }`
  - Reads `~/apps/` directory with meta.json/matrix.json

## File Structure

```
shell/src/components/groups/
  GroupsApp.tsx           -- main app component (two-panel layout)
  GroupList.tsx           -- left panel: group list + create
  GroupDetail.tsx         -- right panel: selected group detail
  MemberRow.tsx           -- single member row with role/remove controls
  AppRow.tsx              -- single shared app row with unshare
  ShareAppPicker.tsx      -- modal: pick personal app to share
  InviteForm.tsx          -- invite member input + button
```

## UX Rules (from specs/ux-guide.md)

1. **No layout shift**: panels are fixed-width, content scrolls within
2. **Progressive disclosure**: member role dropdown only shows on hover/focus for owners
3. **Empty states are onboarding**: every empty state has icon + description + CTA
4. **Confirmation on destructive actions**: leave, delete, remove, unshare all require confirm
5. **Optimistic updates**: UI updates immediately, reverts on error
6. **Loading states**: skeleton placeholders while fetching, never blank

## Tasks

### Gateway Routes

- [ ] T7c-01: Write failing tests for `PATCH /api/groups/:slug` (rename)
- [ ] T7c-02: Implement `PATCH /api/groups/:slug` — update `m.room.name` + local manifest
- [ ] T7c-03: Write failing tests for `DELETE /api/groups/:slug/apps/:app` (unshare)
- [ ] T7c-04: Implement `DELETE /api/groups/:slug/apps/:app` — remove dir + ACL state event
- [ ] T7c-05: Write failing tests for `PATCH /api/groups/:slug/members/:handle/role`
- [ ] T7c-06: Implement role change — map role to PL, call `setPowerLevels`
- [ ] T7c-07: Write failing tests for `POST /api/groups/:slug/kick`
- [ ] T7c-08: Implement kick — call `matrixClient.kickFromRoom`
- [ ] T7c-09: Write failing tests for `GET /api/apps` (personal apps list)
- [ ] T7c-10: Implement `GET /api/apps` — read `~/apps/` with metadata

### Shell Components

- [ ] T7c-11: Create `GroupsApp.tsx` — two-panel layout, fetches groups on mount
- [ ] T7c-12: Create `GroupList.tsx` — group list with create button
- [ ] T7c-13: Create `GroupDetail.tsx` — header + members + apps + settings sections
- [ ] T7c-14: Create `MemberRow.tsx` — member display with role dropdown and remove
- [ ] T7c-15: Create `AppRow.tsx` — shared app display with unshare button
- [ ] T7c-16: Create `ShareAppPicker.tsx` — modal listing personal apps to share
- [ ] T7c-17: Create `InviteForm.tsx` — handle input + invite button + copy link
- [ ] T7c-18: Register Groups app in dock as a system app (like Settings)
- [ ] T7c-19: Remove the old GroupAppList overlay panel from Desktop (replaced by GroupsApp)

### Tests

- [ ] T7c-20: Write Vitest+jsdom tests for GroupsApp (renders, loads groups)
- [ ] T7c-21: Write tests for GroupDetail (members render, invite works, role change, remove)
- [ ] T7c-22: Write tests for ShareAppPicker (lists personal apps, share triggers POST)
- [ ] T7c-23: Run full test suite, verify no regressions

### Polish

- [ ] T7c-24: Update MembersPanel to redirect to GroupsApp instead of being standalone
- [ ] T7c-25: Update ShareAppDialog to redirect to GroupsApp instead of being standalone
- [ ] T7c-26: Docker smoke test: full group management flow from GroupsApp

**Total**: 26 tasks
