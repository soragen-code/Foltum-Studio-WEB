/**
 * Remove explicit named imitations from visual descriptions while keeping project names.
 * This heuristic neither predicts provider moderation nor guarantees approval.
 * Dialogue must be added after this step so spoken words remain intact.
 */

export interface SanitizeOptions {
  /** Names that must never be rewritten (the project's own character names). */
  keep?: string[];
}

export interface SanitizeResult {
  prompt: string;
  /** Human-readable list of rewrites, e.g. `"Angelina Jolie" → "a woman"`. */
  changes: string[];
  changed: boolean;
}

type Rule = { pattern: RegExp; replacement: string };

/** Names are small regex fragments (already escaped where needed); spaces match any whitespace. */
const rx = (names: string[], flags = "gi") =>
  new RegExp(`(?<![\\w])(?:${names.map((n) => n.replace(/ /g, "\\s+")).join("|")})(?:['’]s)?(?![\\w])`, flags);

/* ---------- Real people (actors, directors, musicians, public figures) ---------- */
const ACTRESSES = [
  "Angelina Jolie", "Scarlett Johansson", "Jennifer Lawrence", "Margot Robbie", "Emma Stone", "Emma Watson",
  "Natalie Portman", "Anne Hathaway", "Zendaya", "Sydney Sweeney", "Florence Pugh", "Anya Taylor-Joy",
  "Jenna Ortega", "Gal Gadot", "Charlize Theron", "Nicole Kidman", "Cate Blanchett", "Meryl Streep",
  "Julia Roberts", "Sandra Bullock", "Jennifer Aniston", "Angelina", "Kate Winslet", "Keira Knightley",
  "Megan Fox", "Mila Kunis", "Ana de Armas", "Jessica Alba", "Monica Bellucci", "Audrey Hepburn",
  "Marilyn Monroe", "Grace Kelly", "Taylor Swift", "Beyonc[ée]", "Rihanna", "Ariana Grande", "Billie Eilish",
  "Lady Gaga", "Madonna", "Kim Kardashian", "Kylie Jenner", "Kendall Jenner", "Gigi Hadid", "Bella Hadid",
  "Dua Lipa", "Selena Gomez", "Miley Cyrus", "Adele", "Lana Del Rey", "Zo[eë] Kravitz", "Millie Bobby Brown",
];
const ACTORS = [
  "Brad Pitt", "Leonardo DiCaprio", "Tom Cruise", "Tom Hanks", "Tom Hardy", "Johnny Depp", "Keanu Reeves",
  "Ryan Gosling", "Ryan Reynolds", "Robert Downey Jr\\.?", "Robert De Niro", "Al Pacino", "Denzel Washington",
  "Will Smith", "Dwayne Johnson", "The Rock", "Chris Hemsworth", "Chris Evans", "Chris Pratt", "Henry Cavill",
  "Jason Momoa", "Timoth[ée]e Chalamet", "Austin Butler", "Pedro Pascal", "Oscar Isaac", "Adam Driver",
  "Jake Gyllenhaal", "Matt Damon", "Ben Affleck", "George Clooney", "Hugh Jackman", "Christian Bale",
  "Joaquin Phoenix", "Heath Ledger", "Jared Leto", "Cillian Murphy", "Benedict Cumberbatch", "Idris Elba",
  "Samuel L\\.? Jackson", "Morgan Freeman", "Jack Nicholson", "Harrison Ford", "Arnold Schwarzenegger",
  "Sylvester Stallone", "Bruce Willis", "Jason Statham", "Vin Diesel", "Daniel Craig", "Pierce Brosnan",
  "Sean Connery", "Clint Eastwood", "Marlon Brando", "James Dean", "Humphrey Bogart", "Charlie Chaplin",
  "Bruce Lee", "Jackie Chan", "Elvis Presley", "Michael Jackson", "Kanye West", "Drake", "Eminem",
  "Justin Bieber", "Harry Styles", "The Weeknd", "Bad Bunny", "Elon Musk", "Jeff Bezos", "Mark Zuckerberg",
  "Bill Gates", "Steve Jobs", "Donald Trump", "Joe Biden", "Barack Obama", "Vladimir Putin", "Zelensky",
  "Kim Jong[- ]un", "Xi Jinping", "Emmanuel Macron", "Boris Johnson", "Cristiano Ronaldo", "Lionel Messi",
  "LeBron James", "Michael Jordan", "Kobe Bryant", "David Beckham", "Conor McGregor", "Mike Tyson",
  "Mr\\.? Beast", "PewDiePie", "Andrew Tate", "Joe Rogan", "Gordon Ramsay", "Keanu",
];
const DIRECTORS_AND_DPS = [
  "Wes Anderson", "Christopher Nolan", "Quentin Tarantino", "Stanley Kubrick", "Steven Spielberg",
  "Martin Scorsese", "David Fincher", "Denis Villeneuve", "Ridley Scott", "James Cameron", "Tim Burton",
  "Guillermo del Toro", "Alfred Hitchcock", "David Lynch", "Terrence Malick", "Paul Thomas Anderson",
  "Coen Brothers", "Coen brothers", "Sofia Coppola", "Francis Ford Coppola", "Greta Gerwig", "Jordan Peele",
  "Ari Aster", "Robert Eggers", "Darren Aronofsky", "Danny Boyle", "Edgar Wright", "Guy Ritchie",
  "Zack Snyder", "Michael Bay", "J\\.?J\\.? Abrams", "Peter Jackson", "George Lucas", "Woody Allen",
  "Wong Kar[- ]wai", "Akira Kurosawa", "Hayao Miyazaki", "Bong Joon[- ]ho", "Park Chan[- ]wook",
  "Andrei Tarkovsky", "Ingmar Bergman", "Federico Fellini", "Nicolas Winding Refn", "Gaspar No[ée]",
  "Lars von Trier", "Yorgos Lanthimos", "Alejandro G(?:onz[aá]lez)? I[ñn][aá]rritu", "Alfonso Cuar[oó]n",
  "Roger Deakins", "Emmanuel Lubezki", "Hoyte van Hoytema", "Greig Fraser", "Bradford Young",
  "Robert Richardson", "Janusz Kami[nń]ski", "Vittorio Storaro", "Gordon Willis", "Conrad Hall",
  "Kubrick", "Tarantino", "Spielberg", "Scorsese", "Fincher", "Villeneuve", "Hitchcock", "Nolan",
  "Deakins", "Lubezki", "Malick", "Aronofsky", "Miyazaki", "Tarkovsky", "Fellini", "Refn",
];
const ARTISTS = [
  "Van Gogh", "Picasso", "Monet", "Rembrandt", "Caravaggio", "Vermeer", "Da Vinci", "Leonardo da Vinci",
  "Michelangelo", "Dal[ií]", "Salvador Dal[ií]", "Banksy", "Andy Warhol", "Warhol", "Basquiat", "Klimt",
  "Edward Hopper", "Norman Rockwell", "Frida Kahlo", "Hokusai", "Mucha", "Alphonse Mucha", "Beksi[nń]ski",
  "H\\.?R\\.? Giger", "Giger", "Greg Rutkowski", "Artgerm", "Annie Leibovitz", "Helmut Newton",
  "Gregory Crewdson", "Steve McCurry", "Ansel Adams", "Henri Cartier-Bresson", "Vivian Maier",
];

/* ---------- Films, shows, games, franchises ---------- */
const TITLES = [
  "Blade Runner(?: 2049)?", "Star Wars", "Star Trek", "Harry Potter", "Hogwarts", "Lord of the Rings",
  "The Hobbit", "Game of Thrones", "House of the Dragon", "Westeros", "Breaking Bad", "Better Call Saul",
  "Stranger Things", "The Matrix", "Inception", "Interstellar", "Oppenheimer", "The Dark Knight", "Dune",
  "Avatar", "Titanic", "Pulp Fiction", "Kill Bill", "The Godfather", "Goodfellas", "Scarface",
  "The Terminator", "Terminator", "Jurassic Park", "Jurassic World", "Indiana Jones", "Pirates of the Caribbean",
  "Mission:? Impossible", "James Bond", "007", "John Wick", "Fast (?:&|and) Furious", "Mad Max", "Fury Road",
  "The Hunger Games", "Twilight", "Fifty Shades", "Euphoria", "Black Mirror", "Twin Peaks", "True Detective",
  "Succession", "The Crown", "Squid Game", "Money Heist", "Peaky Blinders", "Sherlock", "Doctor Who",
  "Friends", "The Office", "Seinfeld", "The Sopranos", "The Wire", "Mad Men", "Ozark", "Narcos", "Dexter",
  "Fight Club", "Se7en", "Gone Girl", "The Social Network", "La La Land", "Whiplash", "Drive",
  "Only God Forgives", "Neon Demon", "The Shining", "A Clockwork Orange", "2001: A Space Odyssey",
  "Eyes Wide Shut", "Taxi Driver", "Joker", "The Batman", "Spider-?Man", "Iron Man", "Avengers",
  "Guardians of the Galaxy", "Black Panther", "Wakanda", "Deadpool", "X-Men", "Wolverine", "Superman",
  "Wonder Woman", "Aquaman", "Justice League", "Suicide Squad", "Marvel", "MCU", "DC Comics", "Gotham",
  "The Walking Dead", "Wednesday", "The Witcher", "Cyberpunk 2077", "Cyberpunk: Edgerunners", "Grand Theft Auto",
  "GTA", "Call of Duty", "Fortnite", "Minecraft", "The Last of Us", "God of War", "Halo", "Zelda",
  "Legend of Zelda", "Final Fantasy", "Resident Evil", "Silent Hill", "Assassin'?s Creed", "Elden Ring",
  "Pok[ée]mon", "Attack on Titan", "Demon Slayer", "Naruto", "One Piece", "Dragon Ball", "Death Note",
  "Neon Genesis Evangelion", "Evangelion", "Akira", "Ghost in the Shell", "Spirited Away", "Your Name",
  "Studio Ghibli", "Ghibli", "Pixar", "Disney", "DreamWorks", "Frozen", "Toy Story", "Shrek", "Minions",
  "Despicable Me", "Barbie", "Ken", "Hello Kitty", "Sesame Street", "Alice in Wonderland", "Wizard of Oz",
  "Downton Abbey", "Bridgerton", "Emily in Paris", "Gossip Girl", "Riverdale", "Grey'?s Anatomy",
  "House of Cards", "Homeland", "Prison Break", "Lost", "Chernobyl", "The Boys", "Severance", "The Bear",
  "Saltburn", "Parasite", "Oldboy", "Am[ée]lie", "In the Mood for Love", "Requiem for a Dream",
  "The Truman Show", "American Beauty", "American Psycho", "Wolf of Wall Street", "Casino", "Heat",
  "Sin City", "300", "Watchmen", "V for Vendetta", "Hunger Games", "Divergent", "Maze Runner",
];

/* ---------- Copyrighted / trademarked characters ---------- */
const CHARACTERS = [
  "Mickey Mouse", "Minnie Mouse", "Donald Duck", "Darth Vader", "Yoda", "Baby Yoda", "Grogu", "Stormtrooper",
  "Jedi", "Sith", "Batman", "Bruce Wayne", "Joker", "Harley Quinn", "Catwoman", "Wonder Woman",
  "Iron Man", "Tony Stark", "Captain America", "Hulk", "Thor", "Loki", "Black Widow", "Thanos",
  "Spider-?Man", "Peter Parker", "Venom", "Wolverine", "Deadpool", "Superman", "Clark Kent",
  "Pikachu", "Mario", "Luigi", "Princess Peach", "Sonic the Hedgehog", "Sonic", "Link", "Kirby", "Lara Croft",
  "Master Chief", "Kratos", "Geralt", "Elsa", "Anna", "Olaf", "Shrek", "Donkey", "Buzz Lightyear", "Woody",
  "Homer Simpson", "Bart Simpson", "The Simpsons", "SpongeBob", "Patrick Star", "Rick and Morty",
  "Peter Griffin", "Family Guy", "South Park", "Cartman", "Scooby-Doo", "Bugs Bunny", "Tom and Jerry",
  "Winnie the Pooh", "Snoopy", "Garfield", "Naruto", "Goku", "Vegeta", "Sailor Moon", "Totoro",
  "Sasuke", "Luffy", "Eren", "Levi Ackerman", "Harley", "Voldemort", "Dumbledore", "Hermione",
  "Gandalf", "Frodo", "Gollum", "Legolas", "Aragorn", "Jon Snow", "Daenerys", "Tyrion", "Walter White",
  "Heisenberg", "Jesse Pinkman", "Tony Soprano", "Don Draper", "Sherlock Holmes", "James Bond",
  "Indiana Jones", "Jack Sparrow", "John Wick", "Neo", "Trinity", "Morpheus", "Ellen Ripley", "Xenomorph",
  "Predator", "Terminator", "T-800", "RoboCop", "Godzilla", "King Kong", "Freddy Krueger", "Jason Voorhees",
  "Michael Myers", "Chucky", "Pennywise", "Hannibal Lecter", "Jack Torrance", "Eleven", "Demogorgon",
  "Vecna", "Wednesday Addams", "Addams Family", "Squid Game guards?", "Lightning McQueen", "Groot",
  "Rocket Raccoon", "Black Panther", "Aquaman", "Flash", "Green Lantern", "Ninja Turtles", "Transformers",
  "Optimus Prime", "Bumblebee", "Barbie", "Ken doll", "Hello Kitty", "Pok[ée]mon", "Minion",
];

/* ---------- Brands, logos, trademarked gear ---------- */
const BRANDS: Array<[string[], string]> = [
  [["iPhone", "iPhones"], "smartphone"],
  [["MacBook", "MacBook Pro", "MacBook Air"], "laptop"],
  [["iPad"], "tablet"],
  [["AirPods"], "wireless earbuds"],
  [["Apple Watch"], "smartwatch"],
  [["Apple logo", "Apple"], "sleek tech"],
  [["Samsung", "Galaxy S\\d+", "Huawei", "Xiaomi", "Pixel phone", "Google Pixel"], "smartphone"],
  [["Nike", "Adidas", "Puma", "Reebok", "New Balance", "Under Armour", "Converse", "Vans"], "athletic-brand-free"],
  [["Air Jordans?", "Jordans", "Yeezys?", "Air Force 1s?", "Air Max"], "plain sneakers"],
  [["Coca[- ]Cola", "Coke", "Pepsi", "Sprite", "Fanta", "Red Bull", "Monster Energy", "Starbucks"], "unbranded drink"],
  [["McDonald'?s", "Burger King", "KFC", "Subway", "Domino'?s", "Pizza Hut", "Taco Bell", "Dunkin'?"], "fast-food place"],
  [["BMW", "Mercedes(?:-Benz)?", "Audi", "Porsche", "Ferrari", "Lamborghini", "Bugatti", "Maserati", "Bentley",
    "Rolls[- ]Royce", "Tesla", "Cybertruck", "Toyota", "Honda", "Ford", "Chevrolet", "Chevy", "Cadillac", "Jeep",
    "Range Rover", "Land Rover", "Jaguar", "Volvo", "Volkswagen", "VW", "Lexus", "Mustang", "Corvette", "Camaro",
    "Harley[- ]Davidson", "Ducati", "Kawasaki", "Yamaha"], "unbranded car"],
  [["Rolex", "Patek Philippe", "Audemars Piguet", "Omega watch", "Cartier", "Tiffany(?: & Co\\.?)?"], "luxury watch"],
  [["Gucci", "Louis Vuitton", "LV monogram", "Chanel", "Prada", "Dior", "Herm[eè]s", "Versace", "Balenciaga",
    "Burberry", "Fendi", "Armani", "Dolce & Gabbana", "Yves Saint Laurent", "YSL", "Off-White", "Supreme",
    "Levi'?s", "Zara", "H&M", "Uniqlo", "Ralph Lauren", "Tommy Hilfiger", "Calvin Klein", "Lacoste",
    "Ray-?Bans?", "Oakley"], "designer-label-free"],
  [["Google", "Facebook", "Instagram", "TikTok", "YouTube", "Twitter", "X\\.com", "Snapchat", "WhatsApp",
    "Telegram", "Netflix", "Spotify", "Amazon", "Microsoft", "Windows logo", "Uber", "Airbnb", "Tinder",
    "LinkedIn", "Reddit", "Twitch", "Discord", "OnlyFans", "PayPal", "Visa", "Mastercard", "American Express"],
    "generic app"],
  [["PlayStation", "PS5", "PS4", "Xbox", "Nintendo", "Nintendo Switch", "Game Boy", "Steam Deck"], "game console"],
  [["Marlboro", "Camel cigarettes", "Lucky Strike", "Zippo", "Jack Daniel'?s", "Johnnie Walker", "Hennessy",
    "Heineken", "Budweiser", "Corona beer", "Guinness", "Absolut", "Smirnoff", "Moët(?: & Chandon)?", "Dom P[ée]rignon"],
    "unbranded bottle"],
  [["Kodak Portra(?: \\d+)?", "Kodak Vision ?3(?: \\d+[TD]?)?", "Kodak Ektachrome", "Kodak Gold", "Kodak",
    "Fuji(?:film)? (?:Velvia|Provia|Superia|Eterna|Pro 400H|C200)", "Fujifilm", "Fuji", "Cinestill(?: ?\\d+[TD]?)?",
    "Ilford(?: HP5| Delta)?", "Agfa"], "35mm film stock"],
  [["Arri Alexa(?: Mini| 35| LF)?", "ARRI", "RED (?:Komodo|Dragon|Monstro|Epic|Raptor|V-Raptor)", "RED camera",
    "Sony Venice", "Sony FX\\d", "Sony A7\\w*", "Blackmagic", "Canon (?:EOS|C\\d+|5D|R5)", "Canon", "Nikon", "Leica",
    "Hasselblad", "Panavision", "IMAX", "GoPro", "DJI", "Zeiss", "Cooke(?: anamorphic)?", "Lomo"], "professional cinema camera"],
  [["Technicolor"], "rich saturated color"],
  [["Polaroid"], "instant photo"],
  [["Lego", "LEGO"], "plastic building blocks"],
  [["Barbie doll"], "fashion doll"],
  [["Hollywood sign"], "hillside letters"],
  [["Getty Images", "Shutterstock", "watermark"], ""],
];

/* ---------- Generic "reference" phrases ---------- */
const PROPER = "(?:[A-Z][\\w'’-]*(?:\\s+(?:[A-Z0-9][\\w'’-]*|de|del|van|von|da|the|of|and|&)){0,4})";
const STYLE_PHRASES: RegExp[] = [
  new RegExp(`,?\\s*(?:[Ss]hot|[Ff]ilmed|[Rr]endered|[Dd]rawn|[Pp]ainted|[Dd]esigned|[Dd]irected|[Ll]it)?\\s*(?:[Ii]n|[Aa]fter|[Ww]ith|[Ee]choing|[Cc]hannel(?:l)?ing|[Ee]voking|[Rr]ecalling|[Rr]eferencing|[Mm]imicking|[Ii]mitating|[Cc]opying)\\s+(?:the\\s+)?(?:(?:visual|cinematic|signature|iconic|distinct(?:ive)?|trademark|classic|painterly|photographic|film|animation|art)\\s+)*(?:style|look|aesthetic|manner|vein|tradition|spirit|palette|vibe|mood|feel|way|fashion)s?\\s+of\\s+(?:the\\s+)?${PROPER}(?:\\s+(?:films?|movies?|shows?|series|paintings?|photographs?|games?|era))?`, "g"),
  new RegExp(`,?\\s*(?:[Ii]nspired|[Ii]nfluenced|[Ii]nformed)\\s+by\\s+(?:the\\s+)?${PROPER}(?:['’]s)?(?:\\s+(?:films?|movies?|shows?|series|work|paintings?|photographs?|cinema|aesthetic|style|look))?`, "g"),
  new RegExp(`,?\\s*(?:[Rr]eminiscent|[Ee]vocative|[Rr]edolent)\\s+of\\s+(?:the\\s+)?${PROPER}(?:['’]s)?(?:\\s+(?:films?|movies?|shows?|series|work|cinema|aesthetic|style|look))?`, "g"),
  new RegExp(`,?\\s*(?:[Aa]n?\\s+)?(?:[Hh]ommage|[Hh]omage|[Tt]ribute|[Nn]od|[Cc]allback|[Tt]hrowback)\\s+to\\s+(?:the\\s+)?${PROPER}`, "g"),
  new RegExp(`,?\\s*[àa]\\s+la\\s+${PROPER}`, "g"),
  new RegExp(`,?\\s*(?:[Jj]ust\\s+)?[Ll]ike\\s+(?:in\\s+|the\\s+(?:famous|iconic|classic|opening|final|ending|climactic|legendary)\\s+(?:scene|shot|sequence|moment|frame)\\s+(?:in|from|of)\\s+)${PROPER}`, "g"),
  new RegExp(`,?\\s*(?:[Ss]traight\\s+)?(?:[Oo]ut\\s+of|[Ff]rom)\\s+(?:an?\\s+|the\\s+)?${PROPER}\\s+(?:film|movie|show|series|game|poster|music\\s+video)`, "g"),
  // "Kubrick-esque", "Fincher-style", "Wes Anderson-like", "Ghibli-inspired"
  new RegExp(`\\b${PROPER}[-‑ ](?:esque|style|styled|like|inspired|ian|ish)\\b`, "g"),
];
const LOOKALIKE = new RegExp(
  `(?:[Ww]ho\\s+)?(?:[Ll]ooks?|[Ll]ooking|[Aa]ppears?|[Aa]ppearing|[Rr]esembl(?:es|ing)|[Mm]odell?ed|[Bb]ased|[Ss]tyled|[Dd]ressed|[Mm]ade\\s+up)\\s+(?:exactly\\s+|a\\s+lot\\s+|just\\s+)?(?:like|after|on|as)\\s+(?:an?\\s+young\\s+|an?\\s+)?${PROPER}(?:\\s+(?:in|from)\\s+${PROPER})?`,
  "g"
);
const LOOKALIKE_NOUN =
  /\b(?:a\s+)?(?:dead\s+ringer|doppelg[aä]nger|look-?alike|lookalike|clone|spitting\s+image|twin)\s+(?:for|of)\s+(?:the\s+)?[A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*){0,3}/g;
const CELEB_GENERIC = /\b(?:a\s+)?(?:famous|well-?known|iconic|legendary|Hollywood|A-list)\s+(?:actor|actress|celebrity|movie\s+star|singer|pop\s+star|rapper|athlete|influencer|model|director|politician|president)s?\b/gi;

/* Words that are ordinary English AND appear in the lists — only rewrite when the
   surrounding context is clearly a reference (they are handled by the generic rules). */
const AMBIGUOUS = new Set([
  "friends", "lost", "heat", "drive", "casino", "flash", "link", "neo", "trinity", "eleven", "anna", "ken", "sonic",
  "donkey", "woody", "predator", "avatar", "joker", "thor", "loki", "twin", "wednesday", "300", "apple", "coke",
  "sprite", "subway", "ford", "jeep", "amazon", "windows logo", "visa", "camel cigarettes", "corona beer", "monster energy",
  "x.com", "fuji", "canon", "lomo", "red camera", "arri", "dji", "hulk", "venom", "watermark", "akira", "dune", "frozen",
  "heisenberg", "severance", "the bear", "the office", "the wire", "the boys", "homeland", "parasite", "oldboy",
  "jedi", "sith", "mario", "luigi", "kirby", "elsa", "olaf", "shrek", "morpheus", "vegeta", "goku", "naruto", "luffy",
  "eren", "harley", "hermione", "gandalf", "frodo", "gollum", "legolas", "aragorn", "voldemort", "dumbledore",
  "trinity", "godzilla", "chucky", "pennywise", "vecna", "demogorgon", "groot", "bumblebee", "minion", "yoda", "grogu",
  "stormtrooper", "sasuke", "totoro", "sailor moon",
]);

function isKept(match: string, keep: Set<string>): boolean {
  const m = match.toLowerCase().replace(/['’]s$/, "").trim();
  for (const k of keep) {
    if (!k) continue;
    if (m === k || m.includes(k) || k.includes(m)) return true;
  }
  return false;
}

/** Replace with a bare noun phrase; when the replacement is empty, collapse whitespace. */
function apply(text: string, pattern: RegExp, replacement: string | ((m: string) => string), keep: Set<string>, changes: string[], label: string) {
  return text.replace(pattern, (m: string) => {
    if (isKept(m, keep)) return m;
    const rep = typeof replacement === "function" ? replacement(m) : replacement;
    changes.push(`${label}: "${m.trim()}" → "${rep}"`);
    return rep;
  });
}

function nameToGeneric(name: string, list: "female" | "male" | "person"): string {
  if (list === "female") return "a woman";
  if (list === "male") return "a man";
  return "a person";
}

/**
 * Remove explicit named imitations from visual descriptions; this is not a moderation guarantee.
 * Pure function — never touches the DB; callers keep the original prompt for reference.
 */
export function sanitizeVideoPrompt(input: string, options: SanitizeOptions = {}): SanitizeResult {
  const keep = new Set((options.keep ?? []).map((k) => k.toLowerCase().trim()).filter(Boolean));
  // also keep individual first names / surnames of the project's characters
  for (const k of Array.from(keep)) for (const part of k.split(/\s+/)) if (part.length > 2) keep.add(part);

  const changes: string[] = [];
  let text = input ?? "";

  // 1. Whole reference phrases first ("in the style of X", "like the iconic scene from X", "X-esque").
  for (const re of STYLE_PHRASES) text = apply(text, re, "", keep, changes, "style reference");
  text = apply(text, LOOKALIKE, "", keep, changes, "lookalike");
  text = apply(text, LOOKALIKE_NOUN, "", keep, changes, "lookalike");
  text = apply(text, CELEB_GENERIC, (m) => (/actress|singer|pop star|model/i.test(m) ? "a woman" : "a person"), keep, changes, "celebrity");

  // 2. Named lighting techniques → technical description, then real people → generic.
  text = apply(text, /\bRembrandt(?:[- ]style)?\s+light(?:ing)?\b/gi, "classic three-quarter portrait lighting", keep, changes, "artist");
  text = apply(text, /\bCaravaggio(?:[- ]style|-?esque)?\s+(?:light(?:ing)?|chiaroscuro)\b/gi, "dramatic chiaroscuro lighting", keep, changes, "artist");
  text = apply(text, /\b(?:Vermeer|Hopper)(?:[- ]style|-?esque)?\s+light(?:ing)?\b/g, "soft directional window lighting", keep, changes, "artist");
  text = apply(text, rx(ACTRESSES), (m) => nameToGeneric(m, "female"), keep, changes, "real person");
  text = apply(text, rx(ACTORS), (m) => nameToGeneric(m, "male"), keep, changes, "real person");
  text = apply(text, rx(DIRECTORS_AND_DPS), "a filmmaker", keep, changes, "director/DP");
  text = apply(text, rx(ARTISTS), "an artist", keep, changes, "artist");

  // 3. Titles / characters. Unambiguous names are rewritten anywhere; names that are also
  // ordinary English words ("Friends", "Lost", "Joker", "Neo") only when the context marks
  // them as a reference ("dressed as Joker", "poster of Lost", "like in Friends").
  const guarded = (names: string[]) => names.filter((n) => !AMBIGUOUS.has(n.toLowerCase()));
  const ambiguous = (names: string[]) => names.filter((n) => AMBIGUOUS.has(n.toLowerCase()));
  text = apply(text, rx(guarded(TITLES)), "an original story", keep, changes, "title");
  text = apply(text, rx(guarded(CHARACTERS)), "an original character", keep, changes, "character");
  const CONTEXT = "(?:as|of|from|in|like|resembling|cosplaying|watching|playing|costume|mask|outfit|suit|poster|scene|episode|show|film|movie|series|game|character)\\s+(?:the\\s+|a\\s+|an\\s+)?";
  text = apply(text, new RegExp(`\\b${CONTEXT}(?:${ambiguous(TITLES).map((n) => n.replace(/ /g, "\\s+")).join("|")})(?![\\w])`, "g"), "an original story", keep, changes, "title");
  text = apply(text, new RegExp(`\\b${CONTEXT}(?:${ambiguous(CHARACTERS).map((n) => n.replace(/ /g, "\\s+")).join("|")})(?![\\w])`, "g"), "an original character", keep, changes, "character");

  // 4. Brands → generic alternatives.
  for (const [names, rep] of BRANDS) {
    const ambig = names.filter((n) => AMBIGUOUS.has(n.toLowerCase()));
    const safe = names.filter((n) => !AMBIGUOUS.has(n.toLowerCase()));
    if (safe.length) text = apply(text, rx(safe), rep, keep, changes, "brand");
    if (ambig.length) text = apply(text, rx(ambig, "g"), (m) => (/^[A-Z]/.test(m) ? rep : m), keep, changes, "brand");
  }
  // Logos / trademarks in general.
  text = apply(text, /\b(?:visible|prominent|recognizable|famous|brand(?:ed)?)\s+(?:logos?|trademarks?|brand(?:ing| names?)?|insignia)\b/gi, "no logos", keep, changes, "logo");

  // 6. Tidy: doubled generic phrases, whitespace, dangling punctuation.
  text = text
    .replace(/\b(a woman|a man|a person|an artist|a filmmaker|an original (?:story|character))\s+\1\b/g, "$1")
    .replace(/\b(?:an? )?(?:athletic-brand-free|designer-label-free)\s+(sneakers?|shoes?|trainers?|jacket|hoodie|dress|bag|handbag|suit|coat|shirt|t-shirt|cap|sunglasses|logo)s?\b/gi, "plain unbranded $1")
    .replace(/\b(?:athletic-brand-free|designer-label-free)\b/g, "unbranded")
    // articles: "a an original character poster" → "an original…", "an smartphone" → "a smartphone"
    .replace(/\b(?:a|an|the)\s+(an?|the)\s+/gi, "$1 ")
    .replace(/\ba\s+(?=[aeiouAEIOU])/g, "an ")
    .replace(/\ban\s+(?=[^aeiouAEIOU\s])/g, "a ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,;:])\s*([,;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/(^|\n)\s*[.,;:]+\s*/g, "$1")
    .replace(/,\s*(\n|$)/g, "$1")
    .replace(/^\s*,\s*/gm, "")
    .trim();

  return { prompt: text, changes, changed: changes.length > 0 };
}

/* ====================================================================================== */
/*  Video-model moderation (Seedance E005 "input or output was flagged as sensitive")      */
/* ====================================================================================== */

/**
 * Softening level used for the paid Seedance submission:
 *  1 — always applied: explicit violence / weapons / blood / intimacy / drugs / death / danger
 *      → neutral cinematic equivalents (the scene keeps its meaning, only the wording changes);
 *  2 — 1st automatic retry after E005: also tones down aggression and physical intensifiers
 *      ("angry", "sharp gesture", "rising anger, cracking voice");
 *  3 — 2nd retry: additionally removes physical contact / danger from the staging lines
 *      ([ACTION], [NON-VERBAL], [BLOCKING]) and neutralises delivery cues.
 */
export type SoftenLevel = 1 | 2 | 3;

export interface SoftenResult {
  text: string;
  /** Original phrases that were rewritten (for logs and the user-facing hint). */
  hits: string[];
  changed: boolean;
}

type SoftRule = [RegExp, string];
/** Unicode-aware word rule (English + Russian words), case-insensitive. */
const w = (alts: string, flags = "giu"): RegExp => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, flags);

/** Level 1 — explicit content that video-model moderation reliably flags. */
const SENSITIVE_L1: SoftRule[] = [
  // weapons
  [w("guns?|pistols?|revolvers?|rifles?|shotguns?|firearms?|handguns?|пистолет\\p{L}*|ружь\\p{L}*|винтовк\\p{L}*|оружи\\p{L}*"), "small object"],
  [w("knife|knives|blades?|daggers?|machetes?|нож\\p{L}*|лезви\\p{L}*|кинжал\\p{L}*"), "tool"],
  [w("bombs?|explosives?|grenades?|explosions?|explodes?|бомб\\p{L}*|взрыв\\p{L}*"), "loud noise"],
  [w("shoots? (?:him|her|them|at)|shot (?:him|her|them)|gunshots?|opens? fire|стреля\\p{L}*|выстрел\\p{L}*"), "points at"],
  // violence / injury
  [w("kills?|killed|killing|murders?|murdered|slaughters?|убива\\p{L}*|убил\\p{L}*|убить|убийств\\p{L}*"), "confronts"],
  [w("stabs?|stabbed|stabbing|strangles?|chokes?|choking|suffocat\\p{L}*|душит|задуш\\p{L}*"), "grips"],
  [w("punch(?:es|ed|ing)?|slaps?|slapped|slapping|kicks?|kicked|beats? (?:him|her|them) up|hits? (?:him|her|them)|strikes? (?:him|her|them)|бьёт|бьет|ударя\\p{L}*|удар\\p{L}*|пощечин\\p{L}*|пощёчин\\p{L}*|избива\\p{L}*"), "gestures sharply toward"],
  [w("blood|bloody|bleeding|bleeds?|gore|gory|wounds?|wounded|injur(?:y|ies|ed)|кров\\p{L}*|ран\\p{L}{1,4}|окровавлен\\p{L}*"), "shaken"],
  [w("corpses?|dead bod(?:y|ies)|body bags?|труп\\p{L}*|мертв\\p{L}*|мёртв\\p{L}*"), "still figure"],
  [w("dies|died|dying|death|deadly|lethal|умира\\p{L}*|умер\\p{L}*|смерт\\p{L}*|гибел\\p{L}*|погиб\\p{L}*"), "loss"],
  [w("suicide|suicidal|hangs? (?:him|her)self|самоубий\\p{L}*"), "despair"],
  [w("tortures?|tortured|torturing|hostages?|kidnap\\p{L}*|abducts?|abducted|пыт(?:ает|ка|ки)|заложник\\p{L}*|похи(?:щ|т)\\p{L}*"), "pressures"],
  [w("violent(?:ly)?|violence|brutal(?:ly)?|savage(?:ly)?|жесток\\p{L}*|насили\\p{L}*"), "tense"],
  [w("threatens?|threatened|threatening|threats?|угрожа\\p{L}*|угроз\\p{L}*"), "warns"],
  // danger to children / people
  [w("drown(?:s|ed|ing)?|тонет|утону\\p{L}*|тону\\p{L}*"), "struggles in the water"],
  [w("(?:child|kid|boy|girl|teen(?:ager)?s?|children|kids) (?:in danger|at risk|trapped|hurt|injured|screaming|crying for help)"), "young people nearby"],
  [w("burns? alive|on fire|catches fire|ablaze|горит|загора\\p{L}*|пожар\\p{L}*"), "brightly lit"],
  [w("crash(?:es|ed|ing)?|collision|car accident|авари\\p{L}*|катастроф\\p{L}*"), "sudden stop"],
  // intimacy / nudity
  [w("naked|nude|nudity|undress(?:es|ed|ing)?|topless|lingerie|underwear|обнаж\\p{L}*|голы\\p{L}*|раздева\\p{L}*|нижн\\p{L}* бель\\p{L}*"), "fully dressed"],
  [w("sex|sexual(?:ly)?|sexy|seductive(?:ly)?|erotic|intimate scene|makes? love|секс\\p{L}*|эротич\\p{L}*|соблазн\\p{L}*|интимн\\p{L}*"), "close"],
  [w("kiss(?:es|ed|ing)? passionately|passionate kiss|страстн\\p{L}* поцелу\\p{L}*"), "embraces warmly"],
  // substances
  [w("cocaine|heroin|meth|drugs?|drug dealers?|syringes?|needles?|overdos(?:e|es|ed)|наркотик\\p{L}*|шприц\\p{L}*|передозировк\\p{L}*"), "medicine"],
  [w("drunk|wasted|hungover|пьян\\p{L}*"), "tired"],
  // crime wording
  [w("rape[ds]?|raping|molest\\p{L}*|abus(?:e|es|ed|ing)|изнасил\\p{L}*|растле\\p{L}*"), "mistreats"],
  [w("terrorist\\p{L}*|terror|extremist\\p{L}*|террор\\p{L}*|экстремист\\p{L}*"), "stranger"],
];

/** Level 2 — aggression and physical intensifiers (kept at level 1 because they carry the drama). */
const SENSITIVE_L2: SoftRule[] = [
  [w("angry|angrily|furious(?:ly)?|enraged|rage|raging|wrath|зл(?:о|ой|ая|ится|ой)|злобн\\p{L}*|ярост\\p{L}*|гнев\\p{L}*|бешен\\p{L}*"), "tense"],
  [w("shout(?:s|ed|ing)?|scream(?:s|ed|ing)?|yell(?:s|ed|ing)?|screech\\p{L}*|крич\\p{L}*|кричит|орёт|орет|вопит|визж\\p{L}*"), "raising the voice"],
  [w("aggressive(?:ly)?|aggression|hostile|hostility|menacing|агрессивн\\p{L}*|агресси\\p{L}*|враждебн\\p{L}*"), "firm"],
  [w("grabs?|grabbed|grabbing|shoves?|shoved|shoving|pushes? (?:him|her|them)|yanks?|drags? (?:him|her|them)|хвата\\p{L}*|схват\\p{L}*|толка\\p{L}*|дёрга\\p{L}*|дерга\\p{L}*|тащит"), "reaches toward"],
  [w("slams?|slammed|smash(?:es|ed|ing)?|throws? (?:a|the) [a-z]+ at|шваря\\p{L}*|швыря\\p{L}*|разбива\\p{L}*|хлопа\\p{L}*"), "sets down firmly"],
  [w("sharp (?:gestures?|movements?|motions?)|abrupt (?:gestures?|movements?)|резк\\p{L}* (?:движени\\p{L}*|жест\\p{L}*|взмах\\p{L}*)"), "expressive gesture"],
  [w("clench(?:es|ed|ing)? (?:his |her |their )?(?:fists?|jaw|teeth)|сжима\\p{L}* (?:кулак\\p{L}*|челюст\\p{L}*|зубы)"), "tenses up"],
  [w("rising anger, cracking voice, bitter laugh"), "emotional nuance, a catch in the voice, a quiet laugh"],
  [w("fights?|fighting|fought|brawls?|struggles? with|wrestl\\p{L}*|дра(?:к|л|т)\\p{L}*|бор(?:ется|ются|ьба)"), "argues with"],
  [w("desperate(?:ly)?|desperation|отчаян\\p{L}*"), "anxious"],
  [w("police|cops?|officers?|handcuffs?|arrests?|arrested|полици\\p{L}*|полицейск\\p{L}*|наручник\\p{L}*|арест\\p{L}*"), "official"],
];

const CONTACT_LINES = /^\[(ACTION|NON-VERBAL|BLOCKING)\]:.*$/gmu;
const CUE_IN_SPEECH = /(says in \p{L}+), [^,\n"]{1,60},( (?:lips moving )?on camera)/gu;

function applyRules(text: string, rules: SoftRule[], hits: string[]): string {
  for (const [re, rep] of rules) {
    text = text.replace(re, (m) => { hits.push(m); return rep; });
  }
  return text;
}

/**
 * Rewrites moderation-sensitive wording in the English Seedance prompt (visual directions AND spoken
 * lines) into neutral cinematic equivalents. Idempotent; never touches [Image#] reference notes' URLs.
 */
export function softenForModeration(input: string, level: SoftenLevel = 1): SoftenResult {
  const hits: string[] = [];
  let text = input ?? "";
  text = applyRules(text, SENSITIVE_L1, hits);
  if (level >= 2) text = applyRules(text, SENSITIVE_L2, hits);
  if (level >= 3) {
    // Physical contact / danger lives in the staging lines: replace them with neutral conversational staging.
    text = text.replace(CONTACT_LINES, (m, tag: string) => {
      hits.push(m.slice(0, 60));
      if (tag === "ACTION") return "[ACTION]: the characters talk to each other, turning toward one another as they speak";
      if (tag === "NON-VERBAL") return "[NON-VERBAL]: attentive expressive faces, natural hand gestures while speaking";
      return "[BLOCKING]: the characters stand a step apart, facing each other";
    });
    // Delivery cues carry intensity ("angry", "desperate") — neutralise them all on the last retry.
    text = text.replace(CUE_IN_SPEECH, "$1$2");
  }
  text = text.replace(/[ \t]{2,}/g, " ").replace(/ ,/g, ",");
  return { text, hits: Array.from(new Set(hits)), changed: hits.length > 0 };
}

/** Phrases in the ORIGINAL scene text that a video-model moderation is likely to flag (for the user hint). */
export function moderationHints(text: string): string[] {
  const hits: string[] = [];
  applyRules(text ?? "", [...SENSITIVE_L1, ...SENSITIVE_L2], hits);
  return Array.from(new Set(hits)).slice(0, 6);
}
