# Security Specification - Sober Living Onboarding

## Data Invariants
- A Resident document can only be created by an authenticated user.
- A Resident document's `ownerId` must match the `uid` of the authenticated user who created it.
- Only the owner of a Resident document can read or update it.
- Chat messages are stored in a subcollection under a Resident.
- A user can only read/write messages in their own Resident subcollection.
- Chat messages must have a `senderId` matching the authenticated user's `uid` (unless it's an admin, but we don't have admins yet, so for now, strictly owner).
- Message `text` must be a string and have a maximum size (1000 chars).
- `createdAt` must be the server timestamp.

## The "Dirty Dozen" Payloads (Deny List)
1. **Identity Spoofing**: Creating a resident with a different `ownerId`.
2. **Unauthorized Read**: Reading another user's resident profile.
3. **Unauthorized Update**: Updating another user's resident profile.
4. **ID Poisoning**: Injecting a massive string as a `residentId`.
5. **Ghost Field Update**: Adding an unauthorized field `isAdmin: true` to a Resident document.
6. **Chat Message Spoofing**: Sending a message with a `senderId` that doesn't match the auth `uid`.
7. **Cross-Resident Chat**: Sending a message to another resident's message subcollection.
8. **Massive Message**: Sending a message `text` larger than 1000 characters.
9. **Timestamp Injection**: Providing a client-side `createdAt` timestamp instead of a server timestamp.
10. **State Shortcut**: Updating `status` directly to "active" without going through "pending_review". (Note: We'll enforce basic field checks for now).
11. **PII Leak**: A non-owner attempting to 'get' a resident document.
12. **Null ID**: Attempting to access a document with an empty string or null ID.

## Test Runner (Logic Check)
The `firestore.rules` must reject all the above scenarios.
