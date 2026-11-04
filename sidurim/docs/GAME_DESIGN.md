# Errands: Tel Aviv — Game Design (binding)

Companion documents: `docs/BRIEF.md` (source of truth, wins every conflict) and `docs/ARCHITECTURE.md` (engineering
contract). Working title in UI: **"Sidurim" / "סידורים"** ("errands").

**Reading the numbers.** Tags say where a number comes from:

- **[M]** measured on the real OSM extract or in a throwaway prototype.
- **[A]** checked by arithmetic.
- **[T]** a starting tuning value, not yet playtested. Change it through the owning `tune.js`, not in code.

Every number without a tag is [T]. No game code has been written or playtested yet.

---

## 1. Pillars

1. **Speed is the goal, contact is the cost.** Crazy Taxi rewards recklessness and the brief punishes contact. If
   contact were only a penalty, players would crawl and this would become a traffic sim. So the clock keeps pressure on,
   contact costs money, health and multipliers, and the reward is skimming cars without touching them.
2. **The city is the antagonist.** Traffic is systemic, and the director stages trouble on the player's path so that it
   always arrives, always fairly.
3. **Every errand ends in a public fight over 6.5 m of curb.**
4. **Comedy of driving, never of people.** Road behaviour is the joke. See section 21.

---

## 2. Loops

| Loop | Length | Beats |
|---|---|---|
| Moment | 20 s | Read arrow, sprint, incident, dodge, near miss, chain grows, next light |
| Errand | ~90 s | Phone card, routed drive, `SEARCH`, Spot War, park, payout, maybe knife |
| Run | median ~6 min [A], win 8-10 min [A] | A "Day" of 7 errands, the last always the gan (kindergarten) pickup |

Restart is one key and takes under 2 s.

---

## 3. Measured facts that shaped this design

| Fact | Consequence |
|---|---|
| 76% of road km are one-way [M] | The arrow follows the routed path, never a straight line. Wrong-way driving stays physically possible as a risky shortcut. |
| Route length is about 1.7x crow distance [M, ghost runs, 1.4-2.7] | Errand legs are defined by route length, never crow distance. |
| Traffic mean speed 5-6 m/s; a reference driver reaches: queue-bound and obeying signals 3.9-6.9 m/s; weaving past all cars but obeying signals 8-10 m/s; weaving and running every red 15 m/s [M] | The clock is calibrated to these speeds (section 7). The player can win without running reds, but only just. |
| Signals every ~200 m on Dizengoff, ~760 m on Namir [M] | Dizengoff is stop-go slalom, Namir is a sprint. |
| Errand POIs sit 15-41 m from a parking-tagged road [M] | The contested bay is deliberately placed 70-130 m from the door. |
| 422 of 423 errand POIs have at least 3 legal curb candidates 70-130 m away [M, straight-line distance and simplified kerb rules, so an optimistic proxy for road distance] | Bay selection should succeed; the fallback in section 12.2 covers the rest. |
| 41 of 494 errand POIs (8.3%) are within 60 m of a school, kindergarten, place of worship or hospital [M] | Those POIs are excluded, so no contest ever happens near them. Every errand kind keeps at least 10 targets [M]. |

---

## 4. The player's car

A small white hatchback that has seen things. Kinematic bicycle model with a separate velocity heading. No tyre physics.

| Parameter | Value |
|---|---|
| Body | 4.0 x 1.75 m, wheelbase 2.5 m |
| Top speed | 26.4 m/s (95 km/h); reverse 6 m/s |
| Acceleration | `a = 7.5 * (1 - v/29)` m/s²: 0-60 km/h in 3.3 s, top in 9.3 s, 168 m to reach top [A] |
| Brake | 14 m/s² (deliberately superhuman): 25 m, 1.9 s from top speed [A] |
| Coast drag | 0.8 m/s² |
| Steering | `delta = lerp(34 deg, 6 deg, (v/26)^0.7)`, attack 0.12 s, return 0.08 s |
| Grip | Lateral cap 11 m/s²: 53 deg/s at 12 m/s, min radius 63 m at top speed [A] |
| Velocity-to-heading lerp | 9/s normal, 2.2/s while handbrake held |
| Handbrake | Yaw cap 2.2 rad/s, speed loss 2 m/s², 0.25 s recovery. A 90 deg corner at 16 m/s takes ~0.7 s |
| Green Launch | Throttle within 0.25 s of green: +30% accel for 1.5 s, `BEAT THE HONK` +₪25 |
| Wall contact | Under 30 deg glance keeps 85% of tangential speed. Never a dead stop |
| Horn | Cars in a 12 m forward cone get +30% accel for 2 s. Pedestrians freeze and glare for 1.5 s, so honking at them backfires |

**Surfaces.** Road, no limit. Sidewalk, park and plaza: drivable, cap 14 m/s, camera jolt. Sand: cap 8 m/s. Buildings,
trees, poles, parked cars, fences: solid. Water: solid invisible edge, with the line "The sea is not a shortcut.", no HP and
no contact. The map edge: each road that leaves the extract ends at barriers and a "Road closed since forever." sign, speed
caps at 8 m/s in the last 30 m, and touching the boundary costs no HP and counts as no contact.

**Running red lights** carries no fine ("The camera has been broken since 2019."). The risk is physical: cross traffic
on green does not yield to the player, while AI on green does yield to AI red-runners.

---

## 5. Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / reverse-brake | W or Up / S or Down | RT / LT |
| Steer | A D or Left Right | Left stick |
| Handbrake | Space | A |
| Horn | H | B |
| Hazards: hold 1.0 s to park badly here (section 12.3) | Q | Y |
| Recover: hold 1.5 s below 1 m/s | R | Back |
| Interact (`OUT THE PASSENGER SIDE`) | E | X |
| Toggle parking camera | C | LB |
| Rear-view strip on/off | V | RB |
| Pause | Esc or P | Start |
| Mute | M | |
| Restart at run end | Enter or R | Start |

**Recover** tows the car to the nearest routable lane, in `DRIVE` or `SEARCH`, for -15 s and -₪100. It counts as no contact.
Dead ends, boxed-in spots and wedged cars could otherwise only wait for the clock.

**On foot.** W A S D or arrows move relative to the camera. Space sidesteps. There is no touch support in v1.

---

## 6. Errands

A run is 7 errands. Errand 1 is always `milk`. Errand 2 is drawn from tier 1, errands 3-4 from tier 2, errands 5-6 from
tier 3, with no repeats, and errand 7 is the fixed finale (`gan_pickup`). Each card appears as a phone message with a
one-line joke. Parking completes the errand; there is no walk to the shop in a normal errand.

| # | Tier | Leg, route to the door [A] | Clock multiplier `k` |
|---|---|---|---|
| 1 | 1 | 450 m nominal, about 575 m as pinned | 1.00 |
| 2 | 1 | 550 m | 0.95 |
| 3 | 2 | 650 m | 0.90 |
| 4 | 2 | 750 m | 0.85 |
| 5 | 3 | 850 m | 0.80 |
| 6 | 3 | 950 m | 0.75 |
| 7 | finale | 1050 m | 0.70 |

Route length is measured from the previous parked position to the door. A door under 220 m straight-line from that start is
never accepted: 6.1% of leg-1 candidates sit within 100 m, which makes `SEARCH` instant, and 14.2% within 170 m, which stages
the block around the player [M]. `SENSITIVE` and `NO_FACADE` POIs are never targets. Binding walks this ladder:

1. Def kinds, route length within ±15% of the leg.
2. Def kinds, within ±30%.
3. `fallbackKinds`, within ±30%.
4. Def kinds, then `fallbackKinds`, at the nearest route length of at least 300 m and at most 1.6 x leg.
5. Redraw another unused def of the tier, then of any tier.

There is no "any eligible kind" rung: it fired on up to 49% of bindings for scarce kinds and produced "Fill up" at a pharmacy [M].
On `tlv_center` the ladder always binds: 400 simulated runs and 2,000 legs gave 59%, 22%, 15%, 3% and 1% on rungs 1-5, with no failures
[M, node-level routing]. On a map too small to bind, that errand is skipped and the run still ends at the gan.

**Errand 1 is pinned.** `milk` binds Carrefour on Ibn Gabirol (`n11238493213`) through `target.anchor`, which skips the ladder.
From the spawn in section 19 that is about 575 m, with a right turn and two further signalled junctions [M, node-level routing].
An earlier spawn on Dizengoff had no convenience or supermarket within ±30% of 450 m, and its nearest good pin was 769 m, which
kills a queue-bound player on errand 1 and leaves a typical one 2.5 s [A]. If the anchor is an orphan on another map, the ladder
runs instead.

**Shipped errand set** (`content/tlv_center/errands.js`):

| id | Tier | Kinds, then fallback | Card (English; Hebrew also shipped) |
|---|---|---|---|
| `milk` | 1 | convenience, supermarket | "Milk. Before the gan." |
| `dry_cleaning` | 1 | laundry, dry_cleaning, then convenience | "Pick up the suit from {poi}. The wedding is tonight. It is not your suit." |
| `bank_queue` | 1 | bank | "The bank needs you in person. It will not say why." |
| `grandma_pills` | 2 | pharmacy, then convenience | "Grandma needs her pills from {poi}. She has already called twice." |
| `birthday_cake` | 2 | bakery | "Cake from {poi}. The candles are your problem." |
| `haircut_cancel` | 2 | hairdresser | "Cancel your haircut at {poi} in person. You have practised the speech." |
| `vegetables` | 2 | greengrocer, supermarket | "Tomatoes from {poi}. Not those tomatoes." |
| `butcher` | 3 | butcher, supermarket | "Your mother-in-law's order at {poi}. She wrote the list twice." |
| `ice_cream` | 3 | ice_cream, convenience | "Ice cream from {poi}. Yes, now." |
| `post_office` | 3 | post_office, bank | "Collect the parcel. The slip says you were home." |
| `gas_station` | 3 | fuel | "Fill up. The light has been on since March." |
| `gan_pickup` | finale | synthetic | "The gan closes in eleven minutes. It always closes in eleven minutes." |

**Content guards, enforced by a test:**

- Card text may name a business only through `{poi}`, so no joke attaches to a real shop. A sentence containing `{poi}` must be
  a plain instruction, and the lint rejects `they`, `them` and `their` in it.
- `{poi}` resolves to the current-language name, then the other language's name, then a kind label such as "the bakery".
  63 of 459 eligible POIs have no name, and 111 have no English name [M].
- POIs flagged `sensitive` (place of worship, school, kindergarten, hospital) are never targets, and no errand target or
  contested bay may be within 60 m of one.
- `gan_pickup` is **fictional and never maps to a real kindergarten**. Its target is a synthetic door on a residential
  street at least 60 m from any sensitive POI, labelled only "the gan". The knife never fires on this errand.

---

## 7. Clock and pressure

The run starts with **120 s** on the clock. On parking, the player gets:

`award = (routeLen / 8 + 14) * k * M` where `k = 1 - 0.05 * (n - 1)`, `n` = errand number 1-7, and `M` depends on how the car was
parked. `routeLen` is the route from the start point to the errand's first bay, locked when that bay is set. It is about 100 m
shorter than the leg, which is measured to the door, because the player only ever drives to the bay. Keyed on the door route, the
award paid for 100 m nobody drives, and a good player won with 56 s spare and no SPOTLESS [A].

| Method | `M` |
|---|---|
| Bay | 1.0 |
| Red/white or red/yellow curb | 0.7 |
| Double-park | 0.4 |

Without `M`, a good player who holds Q at each door wins with 76.6 s left, and the Spot War becomes optional [A].

The clock runs in `DRIVE`, `SEARCH` and `HOLD`, and is frozen in `CARD`, `PAYOUT`, `BLOCKED`, `ENCOUNTER` and `RESOLVE`.

**Why these numbers.** The feel proposal's formula (`routeLen/12 + 14`, start 110, legs 550-1200 m) required a sustained
14 m/s to win. Reference-driver ghosts on the real network, at realised density, measured [M]:

| Density N (bubble cars) | Queue-bound, obey signals | Queue-bound, run reds | Weave, obey signals | Weave, run reds |
|---|---|---|---|---|
| 60 | 6.9 m/s | 8.6 | 9.4 | 14.9 |
| 90 | 5.7 | 6.6 | 9.2 | 14.3 |
| 120 | 4.8 | 6.8 | 9.3 | 15.2 |
| 150 | 3.9 | 6.0 | 8.3 | 15.2 |

Mean of 3 seeds, 12 sim-minutes each, on a prototype with no lane changes, no misbehaviours and no incidents. Each run
covers only 2-13 legs, so treat single cells as noisy and the column pattern as the finding. "Queue-bound" never
overtakes, so it is a floor. "Weave" ignores other cars entirely, so it is a ceiling. Real players sit between these
columns. 14 m/s is therefore unreachable without running every red, and the old table was unwinnable in practice.

Re-run with the final per-controller signal timing (ARCHITECTURE 8.3), 8 seeds, same column order [M]: N=100 gives 6.1, 7.2, 8.7 and
15.2 m/s; N=120 gives 5.2, 6.0, 9.0 and 15.1 m/s. Realised N held and traffic sped up slightly, so the tier speeds below stand.

**Calibrated balance** [A, at the reference speeds; validated by `clock` bot in soak, see ARCHITECTURE]:

| Player tier | Avg speed / parking overhead | Without bonuses | With SPOTLESS (+8 s each) |
|---|---|---|---|
| Queue-bound | 6.0 m/s / 20 s | Dies on errand 2 at 3.2 min | Dies on errand 3 at 4.6 min, at best |
| Typical | 7.5 m/s / 15 s | Dies on errand 4 at 5.5 min | Dies on errand 5 at 7.4 min, with at least 2 of them |
| Good | 9.0 m/s / 12 s | Dies on the gan at 9.8 min | Wins at 10.0 min: 2 of 6 with 4.3 s left, 4 of 6 with 20.3 s, 6 of 6 with 36.3 s |
| Expert | 11.0 m/s / 10 s | Wins at 8.2 min with 96.4 s left | Wins with 144.4 s left |

Each errand takes `routeLen / speed + overhead`, and overhead is everything parking adds beyond plain driving, including lost
contests. Bay routes are taken as 460 m for errand 1 (the pinned door minus its approach bay) and the leg minus 100 m otherwise.
Time left is the clock when the gan parks. It excludes the final award, which is worth nothing by then. Only errands 1-6 can add
SPOTLESS seconds, because the gan's own bonus lands after the run is won.

Parking badly at every door, at the same speeds [A]:

| Player tier | Curb each time, near the bay, 4 s | Double-park each time, 50 m before the bay, 3.2 s |
|---|---|---|
| Typical | Dies on errand 4 | Dies on errand 3 |
| Good | Dies on errand 5 | Dies on errand 4 |
| Expert | Dies on the gan | Dies on errand 5 |

Clean driving is what converts a good run into a win. Clock warnings: pulse at 20 s, tick at 10 s.

---

## 8. Damage, money and score

### 8.1 No-Claims bar (car health, 100 HP)

| Contact | Normal closing speed | HP |
|---|---|---|
| Scrape | 0.5 to under 3 m/s | -4 |
| Bump | 3-9 m/s | -12 |
| Crash | over 9 m/s | -30 |
| Rear-ended by another car while straight or braking | any | half of the above |

`rearEnded` contacts cost HP but do not count toward `contacts`, the chain or SPOTLESS: a tailgater contact is unavoidable on any
full stop, at about 0.9 s from 10 m/s, because the player brakes at 14 m/s² and the AI at 8 [A].

Applies to vehicles, parked cars and static solids. Contact below 0.5 m/s is ignored. The same body cannot re-trigger
within 0.5 s. HP 0 ends the run (tow truck). The **only repair** is a SPOTLESS errand (+10 HP), so clean driving is
also healing.

### 8.2 Chutzpah chain (vehicles only)

| Near miss | Condition | Pay |
|---|---|---|
| Near miss | Relative speed at least 6 m/s, gap at most 0.9 m | ₪15 |
| Hair | Relative speed at least 6 m/s, gap at most 0.45 m | ₪40 |

Window 4 s. Multiplier `1 + chain/3`, capped at x5. Chain money banks at each near miss. Any contact except `rearEnded` breaks
the chain and loses the unbanked multiplier, not the bank.

**Pedestrians never feed the chain.** Buzzing them would reward menace. Clearing a staged pedestrian incident by at
least 1.5 m pays a flat `GAVE WAY` +₪10. Cars reward closeness; pedestrians reward distance.

### 8.3 Hitting a pedestrian

Any contact between the moving car and any person or two-wheeler rider:

- -₪500, -30 s, chain broken, this errand's pay is zero, no comic animation.
- The second hit in a run ends it: `LICENCE REVOKED`, played straight.
- This covers everyone, including the attacker, the bay "saver", inspectors and scooter riders. There is no score,
  achievement, rage reduction, or other benefit for it, ever.

### 8.4 Errand pay

`pay = (80 + 0.1 * routeLen) * P * C + chainBank`

| P (parking quality) | Multiplier |
|---|---|
| PERFECT | 1.5 |
| GOOD | 1.2 |
| UGLY | 1.0 |
| DOUBLE (double-parked) | 0.5 |

`C = max(0.25, 1 - 0.25 * contacts)`. Zero contacts in a bay is SPOTLESS: `C = 1.5`, +8 s, +10 HP. Curb and double-park never
earn SPOTLESS, so zero contacts there gives `C = 1.0`.

Knife exits multiply pay (section 15.4). Other bonuses:

| Bonus | Trigger | Pay |
|---|---|---|
| `BEAT THE HONK` | Green Launch | +₪25 |
| `HANDBRAKE PARK` | Capture armed while handbrake held above 7 m/s; paid when the bar fills | +₪150 |
| `AFTER YOU` | Waited behind a committed rival | +₪50, +5 s |
| `GAVE WAY` | Staged pedestrian incident cleared by 1.5 m or more | +₪10 |

### 8.5 Rank

Final rank from total ₪: NEW DRIVER (under 800), BUS DRIVER (under 2000), TAXI DRIVER (under 3500), DELIVERY RIDER
(under 5500), LEGEND OF IBN GABIROL (5500 and up). The tally shows honks received, spots stolen, near misses, contacts,
and errands done.

---

## 9. Behaviour catalog: drivers

Traffic is lane-following IDM with lane changes. Each car samples aggression `ag ~ Beta(2,2)`.

| Parameter | Formula |
|---|---|
| Desired speed factor | `1.05 + 0.35 ag` of lane limit |
| Time headway T | `1.5 - 0.9 ag` s |
| Min gap s0 | `2.2 - 1.2 ag` m |
| Accel a / comfort brake b | `1.4 + 1.0 ag` / `2.2 + 0.8 ag` m/s² |
| Hard brake floor | -8 m/s² for all AI |
| MOBIL politeness | `0.5 (1 - ag)` |
| MOBIL threshold | `0.2 - 0.15 ag` |
| Safe braking for lane change | `3 + 4 ag` m/s² |

Default density is **100 cars** in the 300 m bubble, adaptive between 70 and 120: above 45% stationary over 30 s cut 10%;
below 25% raise 10%. At N=100, traffic measured 5.4 m/s and 26% stationary [M, 4 seeds, prototype without lane changes].

**Ambient** means the behaviour runs autonomously anywhere near the player. **Staged** means the director also forces it
on the player's path (section 11). Concurrency caps apply to ambient only.

| Behaviour | Brief clause | Ambient trigger | Effect | Tuning and exit |
|---|---|---|---|---|
| `RED_RUN` | "crossing in red light" | (a) Late run: amber or first 1.5 s of red, `ag > 0.5`, p 0.15 at stop decision. (b) Jump start: queue head, `ag > 0.7`, under 3 s of red left, p 0.25 per cycle | Skips the phase check and enters the junction | Still takes junction occupancy, so AI on green yields. The player gets no protection. Max 1 per junction per cycle. Ends when connector cleared |
| `HONK` | "behaving very aggressively" | Stopped behind a car 0.2 s after green (`HONK_GREEN_DELAY`); blocked over 2 s with `ag > 0.4` | Horn audio plus `!` bubble. Counts in the tally if aimed at the player | 2 s cooldown per car |
| `TAILGATE` | "sticking to the players car from the back" | Behind the player within 40 m, same lane, `ag > 0.6` | `T = 0.1` s, `s0 = 1.4` m; high beams on, horn every 3 s | 8-20 s, or player leaves lane. Max 2. Braking is capped at -8, so a player braking above 8 m/s² gets rear-ended |
| `NOSE_IN` | "aggressively joining the traffic on busy roads" | From a side road or curb onto a busier lane, gap accepted at 0.8-1.5 s (normal 3-4 s), minimum 4 m | Inserts an obstacle into the target lane, forcing the follower to brake | Follower braking capped at -5. Ends when merged. Max 4 |
| `OVERTAKE_OUT`, `OVERTAKE_PASS`, `CUT_IN` | "bypassing dangerously" | Leader under 60% of desired speed for 3 s, or stopped; `ag > 0.55` | Uses the opposite lane on two-way roads, weaves on multi-lane; passes at 0.6 m lateral gap; cuts back in at 0.5-0.8 s headway | Aborts at head-on TTC under 2 s. Max 3 |
| `PHANTOM_STOP` | "suddenly stop for unclear reasons" | 0.02 per car per minute | Brakes at -4 to -7, sits in lane 5-25 s; driver chats through the window, brake lights on | Never within 15 m of a junction or on an exclusive lane. Max 2 |
| `DROP_APPROACH`, `DROPPED`, `PULLOUT` | "dropping passengers off" | 0.02 per car per minute, near a curb spot | Half in lane at the curb, hazards 0.5 s before stopping, traffic-side door opens, spawns a pedestrian, 8-20 s stop, leaves via `NOSE_IN` | Not on connectors. Max 3 |
| `BUS_STOPPED`, `BUS_PULLOUT` | "aggressively joining" | Every bus at each stop on its lane | Stops 10-15 s half out of lane, then noses out with no blinker | 4% of spawned cars are buses |
| `DOUBLE_PARK` | "stop for unclear reasons" | 0.01 per car per minute | Hazards on, driver gone, blocks the lane 20-40 s, subject to the no-bypass cap below | Same guards as `PHANTOM_STOP`. Max 2 |
| `REVERSE_FOR_SPOT` | "very aggressively" | Staged only | Reverses 30 m down a live lane, reverse lights on | Guarded by fairness gate |
| `DOOR_OPEN` | Flavour | Staged only | A parked car's traffic-side door opens into the lane | 2-3 s |

**Rules that override everything:**

- A car's misbehaviour may never hold it indefinitely: every state exits to `CRUISE` on a timeout.
- AI must never touch a pedestrian. All AI hard-brakes at TTC under `max(0.8, v/16 + 0.25)` s to a person, which is the stopping
  time at -8 m/s² plus margin [A]. Cars with `ag > 0.7` may squeeze past a crossing once the person has cleared their half of
  the road.
- On a lane with no left, right or opposite neighbour, `PHANTOM_STOP`, `DROPPED`, `DOUBLE_PARK` and `BUS_STOPPED` hold at most 6 s
  after the player is within 30 m. 41.8% of route-km is one-lane one-way with parked cars on most of the curb [M], so a 40 s
  block there is dead clock with no player agency. A wreck clears within 6 s in every case, on a tow truck, in view or not.

---

## 10. Behaviour catalog: pedestrians and two-wheelers

Target population: 40-60 active within 120 m of the player. Walkers use generated sidewalks because OSM sidewalk tags
are sparse [M, about 12% of ways].

| State | Brief clause | Trigger | Effect | Tuning |
|---|---|---|---|---|
| `WALK` | | Default | Walks sidewalk at 1.1-1.5 m/s | |
| `WAIT_CROSS` | | At crossing with no right of way | Waits at curb | 25 s max, then may `RED_CROSS` |
| `CROSS_LEGAL` | | Walk phase, or unsignalled zebra with gap | Crosses at 1.3 m/s | |
| `CROSS_SLOW` | "walk slowly" | 12% of crossers | Crosses at 0.6 m/s and may pause mid-road 1-3 s | Dwell capped at 25 s, then hurries off |
| `JAYWALK` | "cross the road unexpectedly" | 3% per minute per walker near a road | Leaves the sidewalk mid-block | Ambient walkers hop back if car TTC falls under 1 s |
| `RED_CROSS` | "cross on red lights" | 15% of waiters, or after 25 s | Crosses against the signal | Same guards |
| `STROLL_ROAD` | "etc." | 2% of walkers on `living_street` or service roads | Walks down the road edge | Moves aside slowly |
| `DROPPED` | "dropping passengers off" | Spawned by `DROPPED` car | Gets out on the traffic side, walks to curb | |
| `FLEE` | | Near a crash | Hurries away 3 s | |
| `STUMBLE` | | After being hit | Sits, stands, shakes head | Non-graphic, 4 s, then leaves |

**Pedestrian fairness.** Before stepping out, a pedestrian shows a readable intent flag for 0.8 s (turns, phone down,
foot off the curb). It never starts if player TTC to that point is under 1.5 s, or if any AI vehicle is within `v²/16 + 3` m of
it. Hop-back applies to ambient walkers only. Commanded walkers with an aim hold their path, and the fairness gate in section 11
protects them; otherwise a staged walker always leaves the conflict point and `GAVE WAY` pays for nothing.

**Two-wheelers** (people, so section 8.3 applies):

| Kind | Brief clause | Behaviour | Tuning |
|---|---|---|---|
| Electric scooter | "etc." | Sidewalk at 6-7 m/s; may ride a one-way the wrong way (`SCOOTER_SALMON`) | Bell cue |
| Delivery rider | "etc." | Leaves the sidewalk at speed into the road at crossings (`DELIVERY_POP`) | 6-9 m/s |

---

## 11. The Balagan director

Random traffic is only statistically dangerous. The director stages incidents on the player's predicted path.

**Pacing.** `heat = (n - 1) / 6` for errand `n`.

| State | Gap between incidents | Notes |
|---|---|---|
| `BUILD` | `lerp(9, 5, heat)` s | Default. Enters `PEAK` every 40-60 s |
| `PEAK` | 4 s | 20 s maximum |
| `BREATHE` | None | 8 s, after any contact or after `PEAK` |

Target 6-8 incidents per minute early and 10-12 late [A]. During `SEARCH`, only incidents marked `search` fire, because
the Spot War is the peak. During `ENCOUNTER`, the director is silent.

**Placement.** Prediction uses the routed path, or the current edge plus the likeliest exit when off route. Pick the
anchor nearest `s = v * TTA`. `leadCar` and `parkedCar` are universal fallbacks. Actors never appear inside 40 m while in
view.

**Aiming.** The actor trajectory is re-solved each tick so the conflict point meets the player. It freezes at `commit`,
1.0 s before impact. Slowing slightly cannot dodge a staged incident, but reacting can.

**Fairness gate.** All must pass, or the incident is re-rolled:

1. `d >= v * t_r + v²/(2 * 14) + 3`, with `t_r` falling from 0.9 s to 0.7 s with heat (52 m at top speed [A]).
2. A telegraph of at least 1.0 s, in frustum or with an audio cue. The HUD also shows a direction chevron, so a muted player
   still gets it.
3. Brake alone works, or a free lane or curb exists.
4. No other incident within 40 m or 3 s.
5. On a lane with no left, right or opposite neighbour, a blocking actor holds at most 6 s after the player is within 30 m.

Soak test: a headless brake-only bot must avoid at least 95% of staged incidents.

### 11.1 Incident catalog

| ID | Behaviour used | Anchor | Telegraph | TTA s | min heat | Search? |
|---|---|---|---|---|---|---|
| `RED_RUNNER` | `RED_RUN` | junction, player green | Horn, engine rising | 2.2-3.0 | 0 | no |
| `BUS_PULLOUT` | `BUS_PULLOUT` | bus stop | Bus nosing out, no blinker | 2.2-3.2 | 0 | no |
| `DOOR_ZONE` | `DOOR_OPEN` | parked car | Silhouette moves, door cracks | 2.0-2.6 | 0 | yes |
| `DROP_OFF` | `DROPPED` | lead car | Hazards 0.5 s before stop, traffic-side door opens | 2.2-3.0 | 0 | yes |
| `STOP_NO_REASON` | `PHANTOM_STOP` | lead car | Brake lights, driver chats through window | 2.0-3.0 | 0 | yes |
| `ZEBRA_ROULETTE` | `JAYWALK` at zebra | crossing | Pedestrian on phone drifts to curb | 2.4-3.2 | 0 | yes |
| `SLOW_CROSS` | `CROSS_SLOW` | crossing | Shopping trolley, blocks lane 6 s, honk chorus | 3.0+ | 0 | yes |
| `RED_WALKER` | `RED_CROSS` | crossing, player green | Walker steps off, eyes on phone | 2.4-3.2 | 0.15 | no |
| `SCOOTER_SALMON` | Scooter wrong way | one-way edge | Two riders wrong way, bell | 2.4-3.2 | 0.15 | no |
| `DELIVERY_POP` | Rider enters road | crossing | Rider leaves sidewalk at speed | 2.2-2.8 | 0.15 | no |
| `TAILGATE` | `TAILGATE` | tail slot | High beams, holds 1.4 m | lasts 6-10 s | 0 | no |
| `OVERTAKE_DIVE` | `OVERTAKE_*` | lead car | Engine, passes at 0.6 m, cuts to a turn | 2.0-2.6 | 0.15 | no |
| `MERGE_WEDGE` | `NOSE_IN` | side street | Nose creeps, accepts a 4 m gap | 2.2-3.0 | 0 | no |
| `DOUBLE_PARK` | `DOUBLE_PARK` | lead car | Hazards, driver gone | 3.0+ | 0 | yes |
| `REVERSE_FOR_SPOT` | `REVERSE_FOR_SPOT` | lead car | Reverse lights, 30 m backwards | 2.2-3.0 | 0.3 | yes |

Each incident also has a `cooldownS` of 30 and a selection `weight` of 3 by default.

---

## 12. Parking rules

### 12.1 What counts as parked

Parking is mandatory. An errand completes only when the car is parked, by one of the routes in section 12.3.

**Bay capture.** A bay is 6.5 x 2.4 m with a capture funnel 3 m longer. Only the errand's current bay can arm capture. Decoy stalls
never can, and neither can free stalls elsewhere, otherwise an errand could finish far from the door.

The car's centre entering the funnel at 7 m/s or less (12 m/s with handbrake held), within ±30 deg of the bay axis in **either**
direction, **arms** capture and takes the bay. Capture fires when speed falls under 1.0 m/s or 1.5 s after arming, and quality
locks from that pose. Leaving the funnel first cancels.

Then the pose snaps into the bay over 0.6 s, then a stationary `HOLD` of 1.2 s fills a bar. Throttle above 50% during `HOLD`
cancels and resets it.

Arming exists because the funnel is only 2.4 m wide. A car from the lane enters near its edge with real yaw, so locking quality on
the first tick would score every capture UGLY.

| Quality | Condition at capture |
|---|---|
| PERFECT | Lateral offset 0.35 m or less, yaw 6 deg or less, no curb touch |
| GOOD | Offset 0.7 m or less, yaw 12 deg or less |
| UGLY | Anything else that captured |

### 12.2 The contested block

Bays are real curb stalls from map data, but occupancy around the target is staged.

- At errand start the director picks the **contested bay**: a free-able stall 70-130 m along the road from the door, on
  an AI-routable lane, at least 60 m from any sensitive POI, preferring blue/white or unpainted curb on the approach
  route. Let `A` be the point on the door route 150 m before the door. A candidate also needs a directed route of at most
  220 m from `A`. If none exists, it widens to 40-180 m by road under the same limit. Failing that, there is no contest and
  the bay is the nearest stall by directed route from `A`. 21% of legs have no approach bay, and unbounded fallbacks detoured
  p90 233 m, max 1.5 km [M].
- A bay is rejected if the road path from it to the door passes within 30 m of a sensitive POI, sampled every 10 m. 4.1% of
  paths do [M], and the 60 m rule covers endpoints only.
- All other stalls within 170 m of the door become occupied, except those within 60 m of the player, so nothing pops in.
- 1-2 **decoys** go 30-60 m from the bay: a hidden motorcycle visible only within 8 m, or a person standing in the bay
  "saving it" (a pedestrian, so section 8.3 applies).
- The route targets the bay from errand start. The door stays on the HUD as a marker.
- `SEARCH` begins when remaining route to the **bay** is 140 m or less. The camera rises. Keyed on the door, the bay would be
  only 40-79 m ahead and no rival could reach it in time [M].
- Target from `SEARCH` entry to `PARKED`: median under 18 s.

If a rival wins a bay, the next bay is the next stall in route order, at most 150 m directed from the lost one. Its parked car
pulls out, so nothing vanishes in view. Maximum two contests per errand, and then the third bay is free. There is no soft lock:
double-parking is always available within 150 m of the door. If no stall qualifies, the arrow goes to the door and only Q parks
the car.

### 12.3 Curbs and legal options

Curb colour is inferred, not observed, because OSM has none [M]. Rules: zone tags give blue/white; `=no`, or within 12 m of
a junction, gives red/white; within 15 m of a bus stop gives red/yellow; otherwise grey. Meanings follow the usual
Israeli convention, from secondary sources.

| Option | How | `M` | Upside | Risk |
|---|---|---|---|---|
| Blue/white or grey bay | Bay capture | 1.0 | Full pay | Rivals |
| Red/white curb | Hold Q 1.0 s while stationary within 1.6 m of the curb, aligned ±20 deg, within 150 m of the door | 0.7 | Always free, near the door | Inspector 40%: -₪200 |
| Red/yellow curb | Same | 0.7 | Always free | Bus horn; tow 60%: -₪300 |
| Double-park | Hold Q 1.0 s while stationary anywhere else within 150 m of the door | 0.4 | Instant, no rival | Pay x0.5; inspector 60%: -₪200 |

Q is one verb, "park badly here", and the curb decides which option it is. Curb options never fire by themselves: on a one-way
lane with no parking strip the lane centre is within about 1.6 m of the curb, so a queue at a light could otherwise park the
player.

Curb options score quality UGLY, except double-parking, which scores DOUBLE. Neither can earn SPOTLESS. On errand 7 both apply
only within 40 m of the door, otherwise the finale is always skippable. Double-parking is the anti-soft-lock valve and lets
the player behave like everyone else.

### 12.4 Leaving

A parked car between two others cannot always steer out, and a fender-bender tax on every errand is not the game. When
the next errand card appears, the car pulls out by itself over 1.0 s to the adjacent lane, facing travel direction, with
parked-car collision off for that second. If a car is within 8 m of that slot it waits up to 3 s, then goes anyway. The card
stays up until the pull-out ends, so the clock never runs while the player is locked.

---

## 13. The Spot War: rival competition

### 13.1 When

| Errand | Contest |
|---|---|
| 1 | Always; tutorial. He holds at the `COMMIT` line until the player parks, and rage is capped at 44, so the player wins and meets the `#@!` bubble and nothing worse |
| 2 | Always |
| 3-6 | Probability `min(0.9, 0.6 + 0.1 * (n - 2))` |
| 7 (gan) | Same formula; rage is capped at 74, so no knife |

### 13.2 The rival

**Source**, at `SEARCH` entry, in order: conscript a live `CRUISE` car ahead on the player's route, not a bus or truck; else spawn
on a hidden side lane; else no contest. Conscription comes first because 35% of approach legs have no side road 15-100 m
upstream of the bay [M], and because the player should watch him arrive.

**Timing.** His ETA to the bay is computed through the whole profile below. Until `BLINK`, his speed scale is re-solved every
0.5 s within 0.5-1.4 to hold that ETA within ±1.5 s of the player's. He may not enter `BLINK` until the player is within 120 m
of the bay.

| State | Trigger | Visible behaviour |
|---|---|---|
| `CRUISE` | Start | Drives to the bay's lane by route |
| `BLINK` | 30 m from bay | Blinker on, slows |
| `CREEP` | After `BLINK` | 5-7 m/s, hugging the curb |
| `COMMIT` | 10 m from bay | Steers in, blocks the lane, 50% inside within 1.5 s |
| `WON` | His body is 50% inside first | He wins; next bay is offered |
| `DENIED` | The player arms first, on a steal (section 14) | He stops in lane within 6 m of the bay until the tier resolves |

A bay is **taken** when the rival's body is 50% inside, or from the moment the player arms capture. The player cannot arm while
the rival's body overlaps the bay. Cancelling `HOLD` returns him to `COMMIT`, so arm-and-cancel never clears a rival.

### 13.3 Yielding

Waiting stationary within 15 m behind a committed rival until he parks pays `AFTER YOU` +₪50 and +5 s, and the next bay
is revealed immediately. This is the honest alternative to fighting.

---

## 14. Rage

Rage is shown as a gauge over the rival during the contest, so it can be read before committing. It is final on the tick the
bar fills, and the result is shown 0.3 s later.

**Steal.** A steal needs the rival in `BLINK` or later, and within 25 m of the bay by route, when the player arms. Otherwise
there is no tier and no rage: he aborts and drives on, so a player can never trigger a knife they had no chance to avoid.

| Factor | Rage |
|---|---|
| Base | 30 |
| His blinker came first | +25 |
| You passed him in the last 30 m | +20 |
| He is within 6 m when you park | +15 |
| You honked at him | +10 |
| Each earlier steal this run | +10 |

| Rage | Tier | Result |
|---|---|---|
| Under 45 | `CURSE` | `#@!` bubble out the window, he drives off |
| 45-74 | `BLOCK` | Pins you for 5 s, shouts in symbols, leaves |
| 75 or more | `KNIFE` | Section 15 |

**Knife rules.** The first knife is forced on errand 2 or 3 by flooring rage to 75 if the player steals a contested bay.
Never on consecutive errands. Maximum 3 per run. Never on errand 1 or the gan. If rage is 75+ and a rule forbids the knife,
the tier becomes `BLOCK`. The same applies if the bay is over 150 m by road from the door, because a 25 s chase covers only
160 m. A player who always yields never sees it; the decision happens before parking, and once parked you own it.

---

## 15. The knife encounter

The brief's sequence: the rival gets out with a knife, tries to get the player out of the car and stab them, and the
player has to run away. The clock is frozen throughout, so it is never a time punishment.

### 15.1 Stages

| Stage | Time | Happens | Player verbs | Exit |
|---|---|---|---|---|
| `STANDOFF` | 1.4 s, time scale 0.6 | He stops nose-in across your bumper, long horn, door opens, low side shot. Attacker appears | None. Controls locked, so the car cannot hit him | To `DOOR_TUG` |
| `DOOR_TUG` | Up to 2.5 s | He always tugs the driver's door, knife visible, bar drains. Prompt `[E] OUT THE PASSENGER SIDE` | E | E: `BAIL`. Bar empty: `DRAGGED` |
| `BAIL` | 0.5 s | You exit the side opposite the driver's door, at a point clear of solids. `lead = 9 - 3 * t_press` m, where `t_press` is seconds into `DOOR_TUG` | None | To `CHASE` |
| `DRAGGED` | 0.8 s | Pulled out, strike 1, lead 0, 2 s invulnerable | None | To `CHASE` |
| `CHASE` | Maximum 25 s | Run to the shop door behind a beacon | Move, sidestep | Section 15.4 |
| `RESOLVE` | 4 s, skippable | Comic card, then back at your car | Any key | Next errand or run end |

### 15.2 Chase numbers

| Item | Value |
|---|---|
| Player run | 6.4 m/s |
| Attacker | 5.7 m/s, or 6.6 m/s when gap exceeds 12 m, so clean running settles at 12 m and only mistakes bring him close [A] |
| Attacker pathing | Follows the player's breadcrumb trail, sampled every 0.25 s |
| Sidestep | 2 m in 0.3 s, 1 s cooldown |
| Lunge | At gap 3.5 m or less: 0.5 s raised-arm windup, 3 m straight, 1.2 s recovery |
| Lunge hit | White flash, stars, 0.5 s stumble, 1.5 s invulnerable, -₪100, strike +1 |
| Brushing a person on foot | 0.4 s at half speed, no penalty, since on foot nobody gets hurt. Same cost for the attacker |
| Staged blockers | 2 on the path: café chairs, a dog leash, two people chatting, a fallen scooter. The attacker loses 0.8 s to each |
| NPC cars | Always brake for people on foot, with a honk chorus. The player on foot cannot be run over |
| Path length | 70-130 m door distance gives 11-20 s of running; 150 m, the limit for a knife, gives 23 s [A] |

### 15.3 Non-graphic rules

No blood, no gore, ever. The knife is chunky and cartoonish. Hits cut to white on contact. Strike 3 is a comic fail. The
attacker is any driver's palette swap plus steam puffs, and his speech is symbols only. No name, dress, accent or
iconography on him or on any NPC.

### 15.4 Every outcome

| Exit | Condition | Payout | Result |
|---|---|---|---|
| `REACHED_SHOP` | Reach the door, including after he stops | Pay x2, +₪300, +15 s | Errand counts |
| `SHAKEN` | Gap 18 m or more, or out of his sight for 3 s: he stops, and the chase continues 6 s, or until 25 s if sooner. Not reaching the door in that time | Pay x1.5 | Errand counts |
| `WHISTLE` | 25 s elapsed | Pay x1. An inspector tickets his double-parked car and he sprints back | Errand counts |
| `CAUGHT` | Strike 3 | None | Run ends |

**Reconnection.** The errand counts on every non-fail exit, because your car is legally parked. `RESOLVE` cuts to your
car: he is arguing with the inspector while his car is towed, which also guarantees your exit is clear. The chain and
clock resume. If `DRAGGED` happens and the player then escapes, pay still applies per the exit table.

If the player hit a pedestrian during the errand, pay stays zero and the exit bonuses are not paid.

---

## 16. On-foot play

On foot is one capped state machine that exists only during `CHASE`. It is not a second game.

- Camera: distance 4.5 m, height 2.2 m, look-ahead 4 m, FOV 70 deg. Rear-view strip stays on so the attacker can be seen.
- A beacon column marks the shop door, and the 3D arrow points straight at it, never along the car route, since one-ways do not
  apply on foot.
- The player collides with buildings, solid props and parked cars, and brushes people.
- There is no entering the car, no weapon, no fighting back and no attack verb. Run away is the only verb, as in the brief.

---

## 17. Win, lose and end screens

No menu beyond a title card, which is needed for audio unlock and carries the OpenStreetMap attribution. Every end shows
a licence-style card with rank, tally, and a one-key restart under 2 s.

| Reason | Condition | Line |
|---|---|---|
| `CLOCK` | Clock reaches 0 | "The gan called. Again." |
| `TOWED` | HP reaches 0 | Tow truck: "Your car has been reassigned." |
| `CAUGHT` | Strike 3 | "You wake on a bench. There is a parking ticket under your shoe." |
| `REVOKED` | Second pedestrian hit | `LICENCE REVOKED` (no joke) |
| `WIN` | Gan parked | "You survived Tuesday." |

High score is kept in browser `localStorage` only as a per-viewer convenience.

---

## 18. Camera

| State | Distance / height | Look-ahead | FOV |
|---|---|---|---|
| Stopped | 6.5 / 2.6 m | 2.5 m | 62 deg |
| Top speed | 8.5 / 3.2 m | 14 m | 82 deg |
| Parking (under 30 m from bay and under 12 m/s; C toggles) | Blend over 0.8 s to height 14 m, pitch 62 deg, car-up not north-up | n/a | 60 deg |
| On foot | 4.5 / 2.2 m | 4 m | 70 deg |

- Yaw spring omega 5/s, lag up to 14 deg, biased toward velocity in a drift so the slide shows.
- Reverse view flips only after 0.6 s above 2 m/s.
- Spring-arm shrink plus building fade in narrow streets.
- **Tailgater trap.** A car 1.4 m behind sits between the camera and the player. When anything is under 5 m behind: raise
  the camera 0.6 m, ghost that car to 40%, and show a low-res rear-view strip (256x64, every second frame).
- Shake `0.25 m * severity`, 0.25 s decay. Near miss: whoosh plus FOV pulse.

---

## 19. First 60 seconds

Starts on King George (HaMelekh George), one lane, at a red light 40 m before the HaNeviim junction, a block from Dizengoff Center,
with a stopped car behind. The route turns right onto HaNeviim and runs straight to the bay, about 460 m from the start, with the
door on Ibn Gabirol.

Beats fire by route distance, not time. Times are for a typical 7.5 m/s.

- **0-3 s:** Title dismissed. Phone card: "Milk. Before the gan." Drive-keys prompt. Red light.
- **3 s:** Green. At 3.2 s the first sound is the car behind honking. Launch prompt.
- **6-9 s, route 40 m:** Right turn onto HaNeviim. Handbrake prompt.
- **9-20 s, route about 120 m:** Sprint. `DROP_OFF` at a soft 3.5 s TTA. First near miss pays out big.
- **20-35 s, route about 220 m:** `ZEBRA_ROULETTE`.
- **35-45 s, route about 300 m:** `RED_RUNNER` at 3.0 s TTA, at the next signal, if the player has green.
- **45-55 s, route about 320 m:** `SEARCH`, camera rises, prompt "SLOW BELOW 25 KM/H, NOSE INTO THE BOX", flashing when over
  speed. The rival blinks and holds at the `COMMIT` line.
- **55-75 s:** `PARKED`. `#@!` bubble. Next card. The first knife can arrive on errand 2.

This scripted sequence runs on errand 1 only and ignores each incident's `minHeat`. If an incident has no valid anchor on
the route, it is skipped. Normal director pacing resumes at `SEARCH`. The player's green is guaranteed by aligning the
signal clock at run start, and `traffic.prewarm` fills the street, because cars otherwise take 28 s to arrive [M].

Two more one-shot prompts wait for a run that needs them, from errand 2 on: "WAIT BEHIND HIM: +5 s" on the first `BLINK`, and
"Q: PARK BADLY" on the first lost bay. On errand 1 the first would be a lie, since he never parks.

---

## 20. HUD and feedback

- Big bold arcade HUD: clock (top centre), money and chain multiplier (top left), No-Claims bar (top right), speed
  (bottom right), minimap with route (bottom left), errand card (top under the clock), current street name (above the minimap).
- Large 3D route arrow above the car, as in Crazy Taxi, always pointing along the routed path 30 m ahead.
- Over a rival: rage gauge. Over the bay: capture bar and marker. The door stays marked on the HUD while the arrow leads to the bay.
- A direction chevron on every incident telegraph.
- Near misses and bonuses pop as large text. Contact: red vignette and bar flash.
- Audio is procedural WebAudio: engine, horns, tyres, whoosh, bell, heartbeat in `CHASE`. No audio files are shipped.
- Default language English, `?lang=he` switches UI and cards to Hebrew, right to left.
- "© OpenStreetMap contributors" appears on the title card and in the pause screen.

---

## 21. Tone rules

Binding on all copy, art and audio. Reviewed in every work package's definition of done.

- Comic satire of Tel Aviv driving, affectionate and absurd, like a cartoon.
- Road behaviour is the joke, not who people are. No ethnic, religious, national or political coding of any antagonist or
  NPC, by name, dress, speech or anything else. No accent jokes. NPC speech is symbols and icons only.
- No iconography on any NPC or vehicle.
- No blood, no gore. Hits show as flash and stumble.
- Hitting a pedestrian is always heavily penalized and never rewarded.
- Real business names appear only as plain-text OSM labels. No reproductions of real logos.
- Jokes never attach to a real business or to a sensitive place.

---

## 22. Tel Aviv flavour list

- Hazards are a legal force field: any car with hazards on may do anything.
- The inspector arrives only when you park badly, always instantly.
- Navigator lines: "Recalculating. Disappointed."; "In 200 metres, regret."
- `HONK_GREEN_DELAY`: the car behind honks 0.2 s after green, every time.
- Promenade and the Rothschild central strip as shortcuts, full of pedestrians.
- Road-adjacent construction areas as closures: "Road closed since forever."
- A person standing in a parking bay saving it for a cousin who is "two minutes away".
- Delivery riders on the sidewalk at 25 km/h. Scooters riding the wrong way, bell ringing.
- Bus that leaves the stop without a blinker because it is the bus.
- Double-parked car, hazards on, driver "just one second" for 40 s.
- Ficus trees over the sidewalk, Bauhaus balconies, rooftop solar boilers, AC units.
- Azrieli towers visible from most of the map as a navigation aid.
- Tow truck that appears with suspicious speed.
- Sea on the west, Ayalon fenced on the east, signs that lie about both.

---

## 23. Scope

**In v1:** all of the above.

**Not in v1, hooks only** (keep the data field or event, do not build):

- Rideable scooter during the chase.
- Rival who returns on a later errand.
- Errand modifiers (`CAKE`, `ICE_CREAM` melt, `LAST_CALL`): the `mod` field stays `null`.
- Home-zone resident sticker.
- Touch controls.
- A packed Hebrew font: v1 uses a system font stack (ARCHITECTURE 14.8).

---

## 24. Requirements traceability

Every clause of the verbatim request, the mechanic that satisfies it, and how to test it. Test names refer to files in
ARCHITECTURE section 17.

| # | Request clause | Mechanic | How to test |
|---|---|---|---|
| 1 | "Build an HTML-javascript (ideally no build) game" | Static files, classic scripts, no bundler | `tests/e2e/file_protocol.e2e.cjs` opens `index.html` over `file://` with network blocked and reaches `DRIVE` |
| 2 | "in the spirit of crazy taxi" | Chase camera, huge arrow, clock with time awards, chain, bold HUD | Screenshot at 1280x720 in `DRIVE`, reviewed by eye; clock award unit test |
| 3 | "with a few twists" | Mandatory parking, Spot War, knife chase | Covered by 22-27 |
| 4 | "The user plays a regular person in Tel Aviv" | Hatchback, phone cards, real OSM streets | Title and first-errand screenshots; street names in HUD match OSM strings |
| 5 | "doing run errands" | A Day of 7 errands from data | `tests/game/errands.test.mjs`: 7 errands bound for 100 seeds, ending in `gan_pickup`, each POI kind matching its def |
| 6 | "The goal is to get to the target place" | Routed arrow and minimap route to the bay, with the door marked | `tests/game/nav.test.mjs`: route legal under one-ways, arrow within 45 deg of next route segment |
| 7 | "and park the car" | Bay capture, pose snap, `HOLD` | `tests/game/parking.test.mjs`: capture at each quality by scripted controls from lane centre |
| 8 | "without inflicting damange" | Contacts cut pay via `C`; SPOTLESS bonus | Forced contact drops `C` by 0.25; SPOTLESS on zero contacts in a bay |
| 9 | "or getting damaged by any other car" | No-Claims HP; run ends at 0; rear-end rule | Scripted impact at each Δv band applies the table; HP 0 gives `TOWED` |
| 10 | "Cars around drive like crazy" | `ag` distribution, IDM parameters, the behaviour table in section 9 | Soak reports nonzero count of each behaviour per 15 sim-min |
| 11 | "crossing in red light" | `RED_RUN`, `RED_RUNNER` | `tests/traffic/behaviours.test.mjs`: car enters junction during red; invariant no AI overlap |
| 12 | "behaving very aggressively" | Honks, short headways, 0.2 s green honk, `NOSE_IN` | Honk within 0.3 s of green with a stopped follower |
| 13 | "sticking to the players car from the back" | `TAILGATE` holding 1.4 m with high beams | Gap at 10 m/s stays in 1.4-3 m for 6 s; hard braking causes rear-end contact at half damage |
| 14 | "aggressively joining the traffic on busy roads" | `NOSE_IN`, `MERGE_WEDGE`, `BUS_PULLOUT` | Merge accepted with gap under 1.5 s; follower decelerates |
| 15 | "bypassing dangerously" | `OVERTAKE_*`, `OVERTAKE_DIVE` | Passes at lateral gap under 1 m, then cuts in at under 0.8 s headway |
| 16 | "pedestrians try to cross the road unexpectedly" | `JAYWALK`, `ZEBRA_ROULETTE` | Scenario forces each; intent flag precedes stepping out by at least 0.8 s |
| 17 | "walk slowly" | `CROSS_SLOW`, `SLOW_CROSS` | Crossing speed 0.6 m/s; zone dwell at most 25 s |
| 18 | "cross on red lights" | `RED_CROSS`, `RED_WALKER` | Pedestrian on road while signal shows no walk phase |
| 19 | "etc." | `STROLL_ROAD`, scooters, delivery riders, decoy savers | Scenarios for `SCOOTER_SALMON` and `DELIVERY_POP` |
| 20 | "Cars may also suddenly stop for unclear reasons" | `PHANTOM_STOP`, `STOP_NO_REASON`, `DOUBLE_PARK` | Lead car decelerates at 4-7 m/s² with no obstacle ahead |
| 21 | "including dropping passengers off" | `DROPPED`, `DROP_OFF` | Pedestrian spawned on traffic side of a stopped car |
| 22 | "Importantly, one has to park the car when they arrive" | Errand completes only on `PARKED`; driving past does nothing | Stopping at the door without parking gives no completion |
| 23 | "a fierce competition of other cars trying to park at the same spot" | Staged block, rival FSM, decoys | `TLV.debug.forceContest()` produces a rival that reaches `COMMIT`; rival can win; next bay is offered. In real flow, soak: the rival reaches `BLINK` in view before capture on at least 80% of contests, and the `errands` bot loses 20-45% of them |
| 24 | "If they park while another car tries to park at the same spot, the driver may get outside with a knife" | Rage tiers; `KNIFE` at 75+; `STANDOFF` | Steal with rage 75 enters `STANDOFF`; rage 44 gives `CURSE`; rage 60 gives `BLOCK` |
| 25 | "and try to get them out of the car" | `DOOR_TUG`, `DRAGGED` | No E press: `DRAGGED` at 2.5 s |
| 26 | "and stab them" | Lunge, non-graphic strike, 3 strikes | Forced lunge hit increments strike, flashes white, no red pixels above threshold in the capture |
| 27 | "so they have to run away" | `CHASE` to the shop door | All four exits reachable from scripted input |
| 28 | "Eventually I'd like a pretty faithful map of Tel Aviv" | Real OSM import; area files; merging extracts | `tools/import.mjs` gates; a second area imports without engine changes |
| 29 | "maybe based on google street view or something like that" | Per the brief: OSM, Mapillary (CC BY-SA) and own photos. Street View is refused | `tools/pack_assets.mjs` rejects `source: streetview` |
| 30 | "so the game should be extensible in that way" | `TLV.q` registry, overlays, anchors, schema versioning | Add a content file with no engine change; overlay survives re-import |
| 31 | "and allow adding graphics for known storefronts, locations, etc." | Storefront and landmark registries, pack tool, fallback ladder | Register a photo and a landmark via data; remove the asset; procedural fallback still renders |

**Brief decisions, for completeness:**

| Decision | Where honoured |
|---|---|
| `file://` and static server | ARCHITECTURE 4, 5 |
| Sim runs in Node, deterministic | ARCHITECTURE 3, 9 |
| Render never mutates sim | ARCHITECTURE 15 |
| Top-down parking camera | Section 18 |
| ODbL attribution in game and docs | Section 20 and `data/maps/<id>/ATTRIBUTION.txt` |
| No Google data | Row 29 |
| Procedural fallback for absent images | ARCHITECTURE 14 |
| No ethnic or similar coding, non-graphic, pedestrian hits never rewarded | Sections 8.3, 15.3, 21 |
| No real logos | Sections 21 and ARCHITECTURE 14 |

---

## 25. Open risks the design carries

1. **Traffic speed and fun are unproven in the final build.** The prototype had no lane changes or misbehaviours; both
   could move speeds in either direction. Mitigation: the `clock` bot in soak; balance only through `tune.js`.
2. **Chaos makes players crawl.** Mitigated by superhuman brakes, the chain, HP rather than instant fail, and the gate.
3. **Parking kills pace, or a block yields no good bay.** Mitigated by snap capture, staged bays and double-parking. The arming
   rule and the rival profile are arithmetic only: the quality thresholds and the 20-45% loss rate need playtesting.
4. **The on-foot mode is the riskiest tone.** Keep to section 15.3, and review all copy and art against section 21.
