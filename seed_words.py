import datetime

common_words = [
    "SUMMER", "WINTER", "SPRING", "AUTUMN", "CIRCLE", "SQUARE", "BOTTLE", "SYSTEM", "PUBLIC", "NUMBER",
    "PLANET", "OFFICE", "PERSON", "PEOPLE", "FAMILY", "COURSE", "MARKET", "POLICE", "NATION", "HEALTH",
    "SCHOOL", "CENTER", "RESULT", "REPORT", "DESIGN", "METHOD", "REGION", "AGENCY", "AMOUNT", "SERIES",
    "GROWTH", "THEORY", "ENERGY", "RECORD", "GROUND", "OBJECT", "LETTER", "WINDOW", "CHANCE", "DEGREE",
    "MOTHER", "FATHER", "SISTER", "FRIEND", "CHURCH", "STREET", "ANIMAL", "MATTER", "PERIOD", "GARDEN",
    "MASTER", "EFFECT", "REASON", "SEASON", "NATURE", "ACTION", "BEAUTY", "BEYOND", "CHOOSE", "CORNER",
    "DAMAGE", "DOCTOR", "EXPERT", "FUTURE", "IMPACT", "ISLAND", "LEADER", "MEMBER", "MEMORY", "MOMENT",
    "OPTION", "PARENT", "PLAYER", "POLICY", "PROFIT", "REVIEW", "SOURCE", "SPEECH", "STRIKE", "TARGET",
    "TICKET", "UPDATE", "VOLUME", "WEALTH", "WEIGHT", "WRITER", "YELLOW", "BRIDGE", "CANCER", "CLIENT",
    "CREDIT", "DETAIL", "EFFORT", "ESTATE", "FARMER", "FLIGHT", "INCOME", "LAWYER", "LENGTH", "LISTEN",
    "MANAGE", "NATIVE", "NOTICE", "PALACE", "PEPPER", "PHRASE", "POCKET", "PRIEST", "RESCUE", "SCREEN",
    "SILVER", "SMOOTH", "SPIRIT", "TALENT", "THANKS", "THRUST", "TISSUE", "UNIQUE", "VALLEY", "WONDER",
    "AUTHOR", "BORDER", "BRANCH", "BREATH", "BURDEN", "CAMERA", "CAMPUS", "CARBON", "CASTLE",
    "CHERRY", "CHEESE", "CLOSET", "COFFEE", "COLORS", "COOKIE", "COTTON", "COUSIN",
    "CUSTOM", "DANGER", "DEALER", "DEBATE", "DEMAND", "DEPUTY", "DEVICE",
    "DINNER", "DIRECT", "DIVIDE", "DOUBLE", "DRAWER", "DRIVER", "EDITOR", "ENGINE", "ESCAPE",
    "EXCUSE", "EXTENT", "FACTOR", "FAILED", "FELLOW", "FINGER", "FINISH", "FLOWER", "FOREST", "FORGET",
    "FORMAT", "FORMER", "FOURTH", "FRENCH", "FRIDAY", "GARAGE", "GATHER", "GENDER", "GLOBAL", "GOLDEN",
    "GUILTY", "HAPPEN", "HEAVEN", "HEIGHT", "HIDDEN", "HOLDER", "HONEST", "HUNTER", "IGNORE",
    "INJURY", "INSIDE", "INTENT", "INVITE", "ITSELF", "JACKET", "JERSEY", "JUNGLE", "JUNIOR", "KEEPER",
    "KILLER", "LADIES", "LATEST", "LAYERS", "LEAGUE", "LEGACY", "LESSON", "LITTLE", "LIVING"
]

themes = {
    "2026-07-09": ["SUGARS", "COOKIE"], # National Sugar Cookie Day
    "2026-07-11": ["PEOPLE", "CROWDS"], # World Population Day
    "2026-07-13": ["FRENCH", "POTATO"], # National French Fry Day
    "2026-07-14": ["FRANCE", "NATION"], # Bastille Day
    "2026-07-17": ["SMILEY", "SYMBOL"], # World Emoji Day
    "2026-07-20": ["APOLLO", "ROCKET"], # Moon Landing Anniversary
    "2026-07-30": ["FRIEND", "AMIGOS"], # International Day of Friendship
    "2026-08-08": ["FELINE", "KITTEN"], # International Cat Day
    "2026-08-09": ["NOVELS", "AUTHOR"], # Book Lovers Day
    "2026-08-12": ["YOUTHS", "MINORS"], # International Youth Day
    "2026-08-19": ["CAMERA", "PHOTOS"], # World Photography Day
    "2026-08-26": ["CANINE", "PUPPER"], # National Dog Day
    "2026-09-05": ["DONATE", "GIVING"], # International Day of Charity
}

# Collect all themed words to ensure no duplicates in generic
themed_words = set()
for t_words in themes.values():
    themed_words.update(t_words)

# Ensure unique, exactly 6 letters, and not in themed_words
generic = list(set([w for w in common_words if len(w) == 6 and w not in themed_words]))

if len(generic) < 100:
    print(f"Warning: Only {len(generic)} generic words available. May wrap around and repeat.")

sql_lines = []
sql_lines.append("DELETE FROM DailyWords;")

curr_date = datetime.date(2026, 7, 8)
gen_idx = 0

for i in range(60):
    date_str = curr_date.strftime("%Y-%m-%d")
    if date_str in themes:
        am_word = themes[date_str][0]
        pm_word = themes[date_str][1]
    else:
        if gen_idx >= len(generic):
            print(f"Ran out of generic words at {date_str}. Wrapping around.")
        am_word = generic[gen_idx % len(generic)]
        gen_idx += 1
        pm_word = generic[gen_idx % len(generic)]
        gen_idx += 1
        
    sql_lines.append(f"INSERT INTO DailyWords (id, word) VALUES ('{date_str}-AM', '{am_word}');")
    sql_lines.append(f"INSERT INTO DailyWords (id, word) VALUES ('{date_str}-PM', '{pm_word}');")
    
    curr_date += datetime.timedelta(days=1)

with open('seed.sql', 'w') as f:
    f.write("\n".join(sql_lines))
