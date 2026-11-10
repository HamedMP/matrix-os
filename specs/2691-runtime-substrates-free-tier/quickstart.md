# Quickstart: qualifying the free tier

Run these on a staging platform with a real container provider, real Postgres, and the
real object store. Record commit, bundle version, provider region, and timings.

## 1. Start free and chat (US1)

1. Register a new account with an invite and no payment method.
2. Choose the free plan.
3. Send "hello". Expect a model answer and a usage record for this owner.
4. Repeat with an uninvited account: expect the waitlist state and no runtime row.

## 2. Build an app (US2)

1. Ask Chat to build a small interactive app that stores records.
2. Open it, add a record.
3. Ask for a visible change. After the rebuild, the change shows and the record remains.
4. Break the source on purpose and rebuild: the failure is shown and source is intact.

## 3. Leave and come back (US3)

1. Wait past the idle limit; confirm the container is gone and compute cost is zero.
2. Reopen: waking, then ready, with chats, files, apps, and records present.
3. Delete the container through the provider; reopen; same result.
4. Kill the container mid-run; reopen; the run is marked interrupted and saved data up
   to the last flush is present.

## 4. Limits (US4)

1. Set a tiny AI allowance; exhaust it; new messages are refused; export still works.
2. Fill storage; writes fail visibly; read, export, and delete still work.
3. Recreate the container; usage is unchanged; the old runtime token is rejected.

## 5. Isolation (SC-004)

With two owners A and B running:

1. From A's sandbox and from A's container shell, try B's database, B's object keys,
   B's private address, the provider metadata endpoint, and a platform internal route
   with A's token and B's handle. All fail.
2. Fire 20 concurrent start requests for a stopped runtime: one container exists.
3. Fire concurrent funded requests at the allowance boundary: total spend stays in budget.

## 6. Upgrade (US5)

1. Capture the inventory of a populated free runtime.
2. Subscribe. Watch the migration states to `completed`.
3. Compare the inventory on the VPS. Confirm the handle is unchanged, balances moved,
   no second starter grant, and the container and its database are deleted.
4. Repeat while injecting a failure at each state; resume; same result.
5. Abandon one migration; the container is writable again.

## 7. Paid controls (US7)

On a paid test VPS, before and after, and during steps 3 to 6: sign-in, chat, app open,
data bridge, reconnect, Terminal, billing page, recovery, and resize behave identically.

## 8. Surfaces (US6)

Repeat steps 1 and 3 on Web Canvas, Electron Desktop, Web Mobile, and Native Mobile.
Capture screenshots and a recording per surface.
