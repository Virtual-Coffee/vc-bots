# VirtualCoffee bots

The Slack and Zoom automation for the VirtualCoffee community: the co-working room, the new-member welcome, the App Home tab, and event announcements. This glossary names the concepts the code and docs should use.

## Co-working room

**Co-working room**:
The community's standing Zoom meeting and its presence in the co-working Slack channel.
_Avoid_: call, meeting, coworking call

**Session**:
One run of the co-working room, from the moment Zoom reports it started until it ends or is declared stale.
_Avoid_: instance, meeting

**Stale session**:
A session whose end was never reported. It is closed when a new session starts or when the safety-net timer fires.

**Room message**:
The single channel message that represents one session (or one announcement) for its whole life. It is posted as an open card and edited in place into an ended card.
_Avoid_: room post, presence message, status message

**Open card**:
The room message while the room is open: the Join button and the live presence list.

**Ended card**:
The room message after the room closes: session stats and the roster. The most recent ended card also carries the standing invite.
_Avoid_: stats summary, closed message

**Standing invite**:
The "start the next session" button on the most recent ended card. Exactly one exists at a time.
_Avoid_: idle invite, CTA

**Retire**:
Strip the standing invite from an ended card because a newer room message has taken over.

**Announcement**:
A room message an admin posts by hand, with no Zoom session behind it. It behaves like a session for the purposes of cards and the standing invite.
_Avoid_: announce-only message, admin announce

**Presence**:
Who is in the room right now.

**Roster**:
Everyone who dropped in during a session, each listed once.
_Avoid_: attendees, participants list

**Member**:
A person in the room who has been matched to their Slack account.

**Guest**:
A person in the room who could not be matched to a Slack account.
_Avoid_: external, unknown participant

**Invite link**:
A personal Zoom join link minted for one member, with their name pre-filled.
_Avoid_: registration link, join url

**Join token**:
The opaque token a member's Join button carries. It resolves to that member's invite link and expires with it.
