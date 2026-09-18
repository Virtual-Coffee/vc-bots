# VirtualCoffee bots

The Slack and Zoom automation for the VirtualCoffee community: the co-working room, the new-member welcome, the App Home tab, event announcements, and the weekly availability check-in. This glossary names the concepts the code and docs should use.

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

**Admin action**:
One thing a workspace admin can make the bots do by hand (run a reminder, send a welcome, publish an App Home, announce the co-working room, manage the calendar watch). The slash command and the admin panel are two ways of requesting the same action; the gate and the outcome are the same whichever asked.
_Avoid_: admin command, panel action, subcommand (for the action itself; a subcommand is how the slash surface spells one)

**Presence**:
Who is in the room right now.

**Roster**:
Everyone who dropped in during a session, each listed once.
_Avoid_: attendees, participants list

**Member**:
A person in the room matched, by the display name on a recent invite link, to their Slack account.

**Guest**:
A person in the room who could not be matched to a Slack account.
_Avoid_: external, unknown participant

**Invite link**:
A personal Zoom join link minted for one member, with their name pre-filled.
_Avoid_: registration link, join url

**Join token**:
The opaque token a member's Join button carries. It resolves to that member's invite link and expires with it.

## Event announcements

**Calendar**:
The Google Calendar that is the system of record for VirtualCoffee events. The bots read events from it and subscribe to its changes; they never write events to it.
_Avoid_: Google API, gcal, events feed

**Calendar watch**:
The bots' subscription to Calendar changes, so a cancellation or reschedule is noticed between daily runs.
_Avoid_: webhook, notification channel, sync channel

**Event**:
One timed entry on the Calendar. The bots read it; they never write it.
_Avoid_: CMS event, reminder event

**Join Link**:
Where members go to attend an event: a Zoom link (with its host key), another URL, a place (free text), or none.
_Avoid_: joinLink property, Zoom link, meeting link

**Host key**:
Zoom's per-user key that lets a moderator claim host in the meeting. Part of a Zoom Join Link and nothing else.
_Avoid_: host code field, zoomHostCode, hostCode property

**Invalid event**:
A timed, live event the bots refuse to announce — today, a Zoom Join Link without a host key. Left out on its own; every other event proceeds.
_Avoid_: bad event, broken event, failed event

**Starting-soon pair**:
The public "Starting Soon" message and its event-admin mirror, both queued for ten minutes before an event starts.
_Avoid_: reminder pair, scheduled messages

**Event-admin mirror**:
The copy of a starting-soon message posted to the event-admin channel with moderator extras (the host key, where the public message went).
_Avoid_: admin copy, admin message

## Availability check-in

**Availability check-in**:
The weekly ask, posted to the hosts channel every Monday, for who can take which role on each event day that week. It is three messages: the intro message and two day messages.
_Avoid_: reminder, poll, roster call

**Intro message**:
The first message of the check-in: the channel-wide ask plus the legend of roles and their emoji.

**Day message**:
One message per event day (Tuesday, Thursday) that carries that day's sign-up sheet. It is edited in place as people react.
_Avoid_: thread, day post

**Role**:
One of the five things a person can sign up for on a day: Host, MC, Notetaker, Room leader, or Unavailable. Each role has one emoji.

**Sign-up**:
One person on one role for one day, expressed by reacting with that role's emoji on the day message. Removing the reaction withdraws it.
_Avoid_: vote, RSVP

**Sign-up sheet**:
The per-role lists of sign-ups on a day message, projected from the message's own reactions. Slack's reactions are the source of truth; the sheet is a rendering of them.
_Avoid_: roster (that is the co-working session's), availability roster

**Seed reactions**:
The five role reactions the bot adds to each day message right after posting, so people can sign up with one click. They are never sign-ups.
