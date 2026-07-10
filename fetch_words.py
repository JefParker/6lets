import urllib.request
import json

url = "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt"
print("Downloading words...")
response = urllib.request.urlopen(url)
data = response.read().decode('utf-8').splitlines()

six_letter_words = [word.strip().lower() for word in data if len(word.strip()) == 6]

print(f"Found {len(six_letter_words)} 6-letter words.")

with open('public/dictionary.js', 'w') as f:
    f.write(f"const VALID_WORDS = new Set({json.dumps(six_letter_words)});\n")
