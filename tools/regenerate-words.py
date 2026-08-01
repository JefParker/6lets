#!/usr/bin/env python3
"""
6Lets -- regenerate future daily words.

WHY THIS EXISTS
---------------
seed.sql and seed_words.py were committed to a PUBLIC repository. Between them
they published the exact answer for every puzzle from 2026-07-08 through
2026-09-05, plus the ~200-word pool the generic days were drawn from. Deleting
those files does not unspoil anything: the blobs stay readable in the git
history, and a public repo has no recall. The only real fix is to change the
words. This script does that.

TWO WORD LISTS, TWO JOBS
------------------------
public/dictionary.js is ~30,000 six-letter words. That is the list of guesses
the game ACCEPTS -- it has to be broad, so players are not told a real word is
invalid. It is a terrible source of ANSWERS: draw from it at random and you get
NESIOT, KALACH, MINYAE. Nobody can solve those, and the guess distribution
turns into a wall of failures.

So answers come from COMMON_WORDS below: ordinary words a player has a fair
chance of reaching. Every one is intersected with dictionary.js before use,
because an answer the client would reject as an invalid guess is literally
unsolvable -- the player could not type it even knowing it. Anything not in
both lists is dropped automatically, so a typo here degrades the pool by one
word rather than shipping a broken puzzle.

WHAT IT GUARANTEES
------------------
  * every answer is common enough to guess, and accepted by the client
  * nothing the public git history ever revealed is reused -- the committed
    tools/burned-words.txt snapshot enforces this even on a fresh clone
  * nothing from the previous run's output file is reused, so consecutive
    runs over different date ranges never schedule the same word twice
  * secrets.SystemRandom, so the schedule is not reproducible from a seed even
    by someone holding this script
  * upserts for future dates only, never a DELETE

USAGE
-----
    python3 tools/regenerate-words.py --start 2026-07-27 --days 120

Review the output, then apply:

    npx wrangler d1 execute sixlets-db --remote --file=./seed.local.sql --yes

NEVER commit the output. It is the answer key.

NEVER run the old seed.sql against production: it opens with
`DELETE FROM DailyWords;`, and Results carries a foreign key to
DailyWords(id) -- it would orphan real player history.
"""

import argparse
import datetime
import os
import re
import secrets
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DICTIONARY = os.path.join(ROOT, 'public', 'dictionary.js')

# Sources of already-published answers. Anything here is burned.
#
# burned-words.txt is the committed snapshot of everything the public git
# history ever revealed, so it works on a fresh clone. seed.sql and
# seed_words.py are the original (retracted, gitignored) files -- still read
# when present, but their content is folded into burned-words.txt, so their
# absence is not a hole.
BURNED_REQUIRED = os.path.join(ROOT, 'tools', 'burned-words.txt')
BURNED_SOURCES = [
    BURNED_REQUIRED,
    os.path.join(ROOT, 'seed.sql'),
    os.path.join(ROOT, 'seed_words.py'),
]

# Every version of the old files combined published at least this many distinct
# words; parsing fewer means a burned source is truncated or mis-parsed.
BURNED_MINIMUM = 200

# Ordinary, guessable six-letter words. Add to this freely -- entries that are
# not exactly six letters, or not present in dictionary.js, are dropped with a
# count reported at the end, so mistakes here are harmless.
COMMON_WORDS = """
abroad absent absorb accent accept access accord across action active actual
adjust admire adopts advice advise affair affect afford afraid agency agenda
agreed albums alerts aliens allied allows almond almost alters always amazed
amount amused anchor angels angles animal ankles annual answer anthem anyone
anyway apples aprons arcade arches arctic argued armies around arrest arrive
arrows artist aspect assert assets assign assist assume assure asthma attach
attack attain attend august author autumn avenue awaits awards
babies backed backup badges bakery ballet ballot bamboo banana banner barrel
basics basket battle beacon beaten beauty became become before begins behalf
behave behind beings belief belong better beyond bigger billed binary births
bishop bitten bitter blades blamed blazer bleach blends blinds blocks blonde
bloody blooms blouse boards boiled bolted bonnet border boring borrow bother
bottle bottom bought bounce bounds bowler boxing braces brains brakes branch
brands breach breaks breast breath breeze bricks bridal bridge briefs bright
brings broken broker bronze brooch browse bruise brunch brutal bubble bucket
budget buffer builds bullet bundle bunker burden bureau burial buried burner
bursts bushes butler butter button buyers buying bypass
cabins cables cactus camera campus canals cancel cancer candle cannon cannot
canvas canyon carbon career caring carpet carrot carved casino castle casual
caught causes ceased cellar cement censor census center cereal chains chairs
chance change charge charms charts chased cheeks cheers cheese cherry chests
chiefs chills choice choose chorus chosen chunks church cinema circle circus
cities claims clause cleans clears clergy clever client cliffs climax climbs
clinic clocks closed closer closet clothe clouds clover clutch coasts coated
coding coffee coffin collar colony colors column combat comedy coming commit
common compel comply copper corner corpse cosmic costly cotton cougar coughs
county couple coupon course courts cousin covers coward cowboy cradle crafts
cranes crayon creams create credit creeks creeps crimes crisis critic crowds
crowns cruise crunch crusts crying cuddle curled curses cursor curves custom
cutter cycles cymbal
dagger damage dancer danger daring darker dashed dating dealer dearly debate
debris debtor decade deceit decent decide decode decree deduct deeper deeply
defeat defect defend define defuse degree delays delete deluxe demand demise
demons denial denied dental depart depend depict deploy deport depths deputy
desert design desire detail detect device devils devote dialog diaper diesel
differ digest digits dilute dinner direct disarm dishes dismay dispel divers
divert divide divine doctor dollar domain donate donkey donors double doubts
dozens drafts dragon drains dramas drawer dreams drifts drills drinks drives
driven driver drones drying duplex duties dwarfs dwells
eagles earned easier easily eating echoes edited editor effect effort eighth
eighty either elders eleven elicit embark embers emblem emerge empire employ
enable enamel encode encore endure energy engage engine enjoys enlist enough
enrich enroll ensure entail enters entire entity envoys equals equity errand
errors escape escort estate esteem ethics ethnic events evolve exceed except
excess excite excuse exempt exhale exiles exists exotic expand expect expert
expire export expose extend extent extras
fabric facade facing factor failed fairly falcon fallen family famine famous
farmer fasten faster father fathom faucet faults favors feared feasts fellow
female fences fervor fevers fibers fiddle fields fierce fights figure filing
filled filter finale finals finder finest finger finish firmly fiscal fishes
fitted fixing flames flanks flicks flight flimsy flirts floats floods floors
floppy floral flower fluent fluids flurry flutes flying folder follow fondly
forbid forced forces forest forged forget forgot formal format former fossil
foster fought fourth framed frames freely freeze frenzy friend fright fringe
frozen frugal fruits fueled fumble funded funnel fusion future
gadget galaxy gallon gallop gamble garage garden garlic gather gauges gender
genius gentle gently ghosts giants gifted giggle ginger giving glance glider
global gloomy gloves goblet golden golfer gospel gossip govern grades grains
grants grapes graphs grasps grassy gravel graves grease greedy greens greets
grieve grinds groans grocer groove ground groups groves growth grudge grunts
guards guests guided guides guilty guitar gutter
habits hacked halted halves hamlet hammer handed handle hanged hangar happen
harbor harder hardly harmed hasten hatred hauled havens hazard header healed
health hearts heated heater heaven hectic hedges height helmet helped helper
herald herbal hereby heroes hidden hiding higher highly hijack hiking hinder
hinges hiring hitter hoarse hockey holder hollow homage honest honors hooked
hornet horror horses hostel hotels hourly houses hovers huddle humane humble
humbly hunger hungry hunted hunter hurdle hybrid hyphen
iconic ideals ignite ignore images immune impact impair impart impede import
impose impure inches income indeed indoor infant infect inform inhale inject
injure injury inland inmate innate inning inputs insane insect insert inside
insist insult insure intact intake intend intent invade invent invert invest
invite invoke inward ironic island issued issues italic itself
jacket jaguar jargon jersey jester jewels jigsaw jockey joined joints jostle
joyful judged judges juggle juices jumble jumped jumper jungle junior juries
justly
karate keeper kennel kernel kettle kicked kidnap kidney killed killer kindly
kisses kitten knight knives knocks koalas
labels labors lacked ladder ladies lagoon lament landed lashes lasted lately
latest latter laughs launch laurel lavish lawful lawyer layers layout lazily
leader league leaked leaned leaped learns leased leases leaves ledger legacy
legend legion legume lemons length lentil lesion lesser lesson letter levels
levers liable lifted lights likely limits linear linens linger liners liquid
liquor listen listed little living lizard loaded loafer locale locals locate
locked locker lodged logged longer longed looked looped loosen looser lotion
loudly lounge lovely lovers loving lowest lumber luxury lyrics
magnet magpie mailed mainly makers makeup making malice mallet mammal manage
manger mangle manner mantle manual marble margin marina marine marked marker
market marrow martyr marvel masked masses master matter mature mayors meadow
meager medals median medium meddle melody melons melted member memory menace
mental mentor merely merger merits messes metals meteor method metric midday
middle midway mighty mildly milder mimics miners mingle minute mirror misery
misfit mishap missed misses mister misuse mitten mixing mobile models modern
modest modify module molded moment monkey months morale morals morgue mortal
mortar mosaic mosque mostly mother motion motive motors mounds mounts mourns
mouths movers movies moving muddle muffin mumble murals murder murmur muscle
museum mussel muster mutant mutter mutual muzzle myself mystic
nailed namely napkin narrow nation native nature naught nausea nearby nearer
nearly needed needle negate nephew nerves nested nestle neural newest nickel
nights nimble ninety nobody nodded noises nomads normal notice notify notion
novels novice nozzle nuance nuclei number nurses nutmeg
oblige oblong obtain occupy occurs oceans octave offend offers office offset
oldest olives omelet onions online onward opaque opened opener openly oppose
optics option oracle orange orbits orchid ordeal orders organs orient origin
ornate orphan others ounces outage outcry outfit outing outlaw outlet output
outset overly owners owning oxygen oyster
packed packet padded paddle pagoda paints palace pallet pamper panels panics
papers parade parcel pardon parent parish parked parlor parody parrot parted
partly passed passes pastel pastor pastry patent patrol patron paused paying
payoff peanut pearls pebble pedals peeled pellet pencil people pepper perils
period perish permit person petals petite petrol phases phones photos phrase
pianos picked picket pickle picnic pieces pierce pigeon pillar pillow pilots
pinned pirate pistol piston pixels plague plains planes planet planks plants
plaque plasma plated plates played player please pledge plenty plight plough
plumes plunge plural pocket podium poetic poetry points poison police policy
polish polite pollen ponder poorly poplar porous portal porter posted poster
postal potato potent potion pounce pounds poured powder powers praise prayer
preach prefer prefix preset pretty priced prices pricey priest primal primer
prince prints prison prized prizes probes profit prompt proofs proper propel
proton proved proven prunes public puddle pulled pulley pulses pumped punish
pupils puppet purely purity purple pursue pushed puzzle python
quaint quarry quartz queens quench quests queues quiche quills quilts quirks
quiver quotas quoted quotes
rabbit racing racket radios radish rafter ragged raided rained raised raisin
ramble rancid random ranged ranger ranges ranked ransom rapids rarely rarity
rascal rating ration rattle ravens ravine razors reacts reader really realms
reason rebels rebuke recall recede recent recess recipe reckon record recoup
redeem reduce refill refine reflex reform refuge refund refuse refute regain
regard regime region regret reject rejoin relate relays relent relics relied
relief relish remain remake remark remedy remind remote remove rename render
renown rental rented repair repeal repeat repent replay report rescue resent
reside resign resist resort rested result resume retail retain retire retort
return reveal revere revise revive revolt reward rhythm ribbon richer riddle
riding rifles rigged ripple rising ritual rivals rivers roasts robbed robins
robust rocked rocket rodent rolled roller rooted roster rotate rotten rounds
router routes rowing royals rubbed rubber rubble rudder rudely rugged ruined
rulers ruling rumble rumors runner runway rushed rustic
sacred saddle safari safely safety sailed sailor salads salary salmon saloon
salute sample sanity satire sauces saucer savage saving savory saying scales
scalps scarce scared scares scarfs scenes scenic scents scheme school scoops
scored scores scotch scouts scrape scraps screen screws scribe script scroll
scrubs scurry sealed search seated second secret sector secure seeing seeker
seemed seized seldom select seller senate sender senior sensed senses sensor
sequel serene serial series sermon served server serves sesame settle severe
sewing shabby shades shadow shaded shaken shaker shakes shaman shaped shapes
shared shares sharks shaved shaver shears sheets shells shelve sherry shield
shifts shines shirts shiver shocks shoots shores shorts should shouts shovel
shower shrank shreds shrewd shriek shrimp shrine shrink shrubs shrugs shrunk
sickly siding sights signal signed silent silver simmer simple simply singer
single sinful siphon sirens sister sitcom sitter sizzle skated skater sketch
skiing skills skinny skirts skulls slaves sledge sleeps sleepy sleeve sleigh
slider slides slight slogan sloped slopes sloppy slowed slower slowly sludge
smells smelly smiled smiles smoked smoker smooth smudge snacks snails snakes
snappy snatch sneaks sneeze sniffs sniper soaked soccer social socket sodium
softly soften solace solely solemn solids solved solves sooner soothe sordid
sorrow sorted sought sounds source spaces spades sparks sparse speaks spears
specks sphere spices spider spikes spills spinal spines spiral spirit splash
spleen splice splint splits spoils spoken sponge spooky spoons sports spotty
spouse sprain sprang sprawl sprays spread spring sprint sprout spruce squads
square squash squeak squire stable stacks stains stairs stakes stalks stalls
stamps stance stands staple stared stares starts starve stated states static
statue status stayed steady steals steams stereo sticks sticky stigma stingy
stinks stitch stocks stolen stones stools stored stores storms stormy strain
strait strand straps strata straws strays streak stream street stress strict
stride strike string stripe strips strive stroke stroll strong struck stucco
studio stumps stunts stupid sturdy subdue submit subtle suburb subway sudden
suffer sugars suited suites sulfur sultry summer summit summon sunken sunset
superb supply surely surfer surges survey swamps swarms sweats sweets swings
switch swivel swords symbol syntax system
tables tablet tackle tactic tailor taking talent talked tandem tangle tanker
target tariff tassel tasted tastes tattoo taught taunts teapot temper temple
tenant tender tendon tennis tenths tenure terror tested thanks theirs themes
theory thesis thighs things thinks thirds thirst thirty thorns thorny though
thread threat thrill thrive throat throne throng throws thrust thumbs ticket
tickle tigers tights tilted timber timely timers timing tinker tinted tiptoe
tissue titled titles toasts toffee toilet tokens tomato topics topped torque
tossed totals toucan touchy towels towers toxins traced traces tracks tracts
trader trades tragic trails trains traits trance trauma travel treats treaty
treble tremor trench trends trendy trials tribal tribes tricks tricky trifle
triple tripod trophy tropic trough troupe trucks trudge trusts truths trying
tucked tumble tumult tundra tunnel turban turkey turned turnip turtle tussle
tutors twelve twenty twists typing typist tyrant
ulcers umpire unable uncles undone uneasy uneven unfair unfold unfurl unions
unique unison united unites unlike unlock unpack unpaid unrest unsafe unseen
unsure untidy untied untold unused unwell unwind unwise upbeat update upheld
uphill uphold upkeep uplift uproar uproot upsets upside uptake uptown upward
urgent usable useful ushers utmost utopia utters
vacant vacuum valley valued values valves vandal vanish vanity vapors varied
varies vaults vector velvet vendor veneer venues verbal verify verses versus
vertex vessel viable victim victor videos viewed viewer violet violin virgin
virtue vision visits visual vocals voiced voices volley volume voters voting
vowels voyage
waffle wagers wagons waited waiter walker wallet wallow walnut wander wanted
warden warmed warmer warmly warned warmth warren washed washer wasted wastes
watery waving weaken weaker weakly wealth weapon weasel weaver wedges weekly
weighs weight welder whales wheels whilst whimsy whirls whisky wholly wicked
wicket widely widens widest widget widows wields wiggle wildly willow window
winery winner winter wiring wisdom wished wishes wither within wizard wobble
wolves wonder wooden woolen worked worker worlds worsen worthy wounds wreath
wrecks wrench wretch wrists writer writes
yachts yearly yellow yields yogurt yonder youths
zealot zenith zephyr zigzag zipper zombie
"""


def read_dictionary():
    """Every six-letter word the client will ACCEPT as a guess, uppercased."""
    if not os.path.isfile(DICTIONARY):
        sys.exit('could not find %s' % DICTIONARY)

    with open(DICTIONARY, 'r', encoding='utf-8') as fh:
        text = fh.read()

    words = {w.upper() for w in re.findall(r"[\"']([a-zA-Z]{6})[\"']", text)}
    if len(words) < 500:
        sys.exit(
            'only parsed %d words from dictionary.js -- refusing to continue.\n'
            'The file format probably changed; check the regex in this script.'
            % len(words)
        )
    return words


def read_burned(extra_files):
    """Words already published anywhere, so they can be excluded."""
    if not os.path.isfile(BURNED_REQUIRED):
        sys.exit(
            'missing %s -- refusing to continue.\n'
            'That file is the committed record of every answer the public git '
            'history gave away; without it this run would reuse spoiled words.'
            % BURNED_REQUIRED
        )

    burned = set()
    for path in BURNED_SOURCES + list(extra_files):
        if not path:
            continue
        if not os.path.isfile(path):
            # Explicit --exclude-file arguments must exist; the optional
            # retracted local files may legitimately be absent.
            if path in extra_files:
                sys.exit('--exclude-file %s does not exist' % path)
            print('  note: burned source %s not present (its words are in %s)'
                  % (os.path.relpath(path, ROOT),
                     os.path.relpath(BURNED_REQUIRED, ROOT)),
                  file=sys.stderr)
            continue
        with open(path, 'r', encoding='utf-8') as fh:
            text = fh.read()
        burned.update(re.findall(r"\b([A-Z]{6})\b", text))

    if len(burned) < BURNED_MINIMUM:
        sys.exit(
            'only %d burned words parsed (expected at least %d) -- a burned '
            'source is truncated or mis-parsed. Refusing to continue.'
            % (len(burned), BURNED_MINIMUM)
        )
    return burned


def read_scheduled(out_path):
    """Words in a previous run's output, so consecutive runs never repeat.

    The authoritative schedule lives in D1, but the last generated file is the
    best local record of it. Words in it are not public -- they are excluded to
    avoid duplicate answers, not because they are burned.
    """
    if not os.path.isfile(out_path):
        return set()
    with open(out_path, 'r', encoding='utf-8') as fh:
        return set(re.findall(r"\b([A-Z]{6})\b", fh.read()))


def backup_path_for(out_path):
    # Keep the backup name ending in .local.sql so the existing gitignore
    # pattern (*.local.sql) covers it too.
    suffix = '.local.sql'
    if out_path.endswith(suffix):
        return out_path[:-len(suffix)] + '.prev' + suffix
    return out_path + '.prev' + suffix


def game_today():
    """Today in the puzzle's timezone (lib/puzzle.js pins America/Los_Angeles),
    not the machine's -- run from another timezone near midnight, the two
    differ and the guard below would allow rewriting a puzzle already in play."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo('America/Los_Angeles')).date()
    except Exception:
        print('  warning: zoneinfo unavailable; using the local date. If this '
              'machine is not on US Pacific time, the "today or earlier" guard '
              'may be off by one day.', file=sys.stderr)
        return datetime.date.today()


def game_ids(start, days):
    for offset in range(days):
        day = start + datetime.timedelta(days=offset)
        stamp = day.strftime('%Y-%m-%d')
        yield '%s-AM' % stamp
        yield '%s-PM' % stamp


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--start', required=True,
                        help='first date to regenerate, YYYY-MM-DD. Must be '
                             'tomorrow or later.')
    parser.add_argument('--days', type=int, default=120,
                        help='how many days to schedule (2 puzzles each). Default 120.')
    parser.add_argument('--out', default=os.path.join(ROOT, 'seed.local.sql'),
                        help='output file. Must stay gitignored. Default seed.local.sql')
    parser.add_argument('--exclude-file', action='append', default=[],
                        help='extra file of uppercase words to avoid. Repeatable.')
    args = parser.parse_args()

    try:
        start = datetime.datetime.strptime(args.start, '%Y-%m-%d').date()
    except ValueError:
        sys.exit('--start must look like 2026-07-27')

    today = game_today()
    if start <= today:
        sys.exit(
            'refusing to regenerate %s: it is today or earlier.\n'
            'Changing a puzzle already in play rewrites the answer under players '
            'mid-game. Use %s or later.'
            % (args.start, today + datetime.timedelta(days=1))
        )

    dictionary = read_dictionary()
    burned = read_burned(args.exclude_file)
    scheduled = read_scheduled(args.out)

    raw = COMMON_WORDS.split()
    wrong_length = [w for w in raw if len(w) != 6]
    common = {w.upper() for w in raw if len(w) == 6}

    # An answer the client would reject as an invalid guess is unsolvable.
    not_in_dictionary = sorted(common - dictionary)
    usable = common & dictionary
    pool = sorted(usable - burned - scheduled)

    ids = list(game_ids(start, args.days))

    if len(pool) < len(ids):
        sys.exit(
            'need %d words but only %d are available after exclusions.\n'
            'Reduce --days, or add more entries to COMMON_WORDS.'
            % (len(ids), len(pool))
        )

    rng = secrets.SystemRandom()
    chosen = rng.sample(pool, len(ids))

    lines = [
        '-- 6Lets daily words. GENERATED FILE -- DO NOT COMMIT.',
        '-- This is the answer key. It belongs only on your machine.',
        '--',
        '-- Generated %s for %s onward (%d days, %d puzzles).'
        % (datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
           args.start, args.days, len(ids)),
        '--',
        '-- Upserts only. No DELETE: Results has a foreign key to DailyWords(id),',
        '-- so removing a row would orphan real player history.',
        '',
    ]
    for game_id, word in zip(ids, chosen):
        lines.append(
            "INSERT INTO DailyWords (id, word) VALUES ('%s', '%s') "
            "ON CONFLICT(id) DO UPDATE SET word = excluded.word;" % (game_id, word)
        )

    backup = None
    if os.path.isfile(args.out):
        # The outgoing file may be the only local copy of the current answer
        # key (D1 has the rest). Keep one generation back instead of clobbering.
        backup = backup_path_for(args.out)
        os.replace(args.out, backup)

    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + '\n')

    print('  common words listed        : %d' % len(raw))
    if wrong_length:
        print('    dropped, not 6 letters   : %d (%s)'
              % (len(wrong_length), ', '.join(wrong_length[:6])))
    if not_in_dictionary:
        print('    dropped, not in dict.js  : %d (%s)'
              % (len(not_in_dictionary), ', '.join(not_in_dictionary[:6])))
    print('  excluded as already public : %d' % len(usable & burned))
    if scheduled:
        print('  excluded, in previous run  : %d (from %s)'
              % (len((usable - burned) & scheduled),
                 os.path.relpath(args.out, ROOT)))
    print('  pool after exclusions      : %d' % len(pool))
    print('  puzzles written            : %d' % len(ids))
    print('  range                      : %s .. %s' % (ids[0], ids[-1]))
    print('')
    print('  sample: %s' % ', '.join(chosen[:8]))
    print('')
    print('  wrote %s' % args.out)
    if backup:
        print('  previous schedule kept as %s' % os.path.relpath(backup, ROOT))
    print('')
    print('  Review it, then apply:')
    print('    npx wrangler d1 execute sixlets-db --remote --file=./%s --yes'
          % os.path.relpath(args.out, ROOT))
    print('')
    print('  Do not commit that file.')


if __name__ == '__main__':
    main()
