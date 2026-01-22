require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const Database = require("better-sqlite3");

// ✅ ID de TON serveur
const GUILD_ID = "1442149382064574598";

// =====================
// DATABASE (SQLite)
// =====================
const db = new Database("casino.db");
db.pragma("journal_mode = WAL");

// Users (wallet + daily + monthly + bank system + rob system)
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    wallet INTEGER NOT NULL DEFAULT 0,
    bank INTEGER NOT NULL DEFAULT 0,
    has_bank INTEGER NOT NULL DEFAULT 0,
    job TEXT NOT NULL DEFAULT 'none',
    anti_rob_until INTEGER NOT NULL DEFAULT 0,
    rob_cooldown_until INTEGER NOT NULL DEFAULT 0,
    bankrob_cooldown_until INTEGER NOT NULL DEFAULT 0,
    last_daily INTEGER NOT NULL DEFAULT 0,
    last_monthly INTEGER NOT NULL DEFAULT 0
  )
`).run();

// Migrations si vieille DB (ajouts de colonnes si absentes)
function safeAlter(sql) {
  try { db.prepare(sql).run(); } catch (_) { /* already exists */ }
}
safeAlter(`ALTER TABLE users ADD COLUMN bank INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE users ADD COLUMN has_bank INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE users ADD COLUMN job TEXT NOT NULL DEFAULT 'none'`);
safeAlter(`ALTER TABLE users ADD COLUMN anti_rob_until INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE users ADD COLUMN rob_cooldown_until INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE users ADD COLUMN bankrob_cooldown_until INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE users ADD COLUMN last_monthly INTEGER NOT NULL DEFAULT 0`); // ton ancien ajout

// Businesses catalog
db.prepare(`
  CREATE TABLE IF NOT EXISTS businesses (
    business_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL,
    income_per_hour INTEGER NOT NULL
  )
`).run();

// User businesses
db.prepare(`
  CREATE TABLE IF NOT EXISTS user_businesses (
    user_id TEXT NOT NULL,
    business_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, business_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (business_id) REFERENCES businesses(business_id)
  )
`).run();

// Meta (for hourly payouts)
db.prepare(`
  CREATE TABLE IF NOT EXISTS economy_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`).run();

// Blackjack games (1 partie active par joueur)
db.prepare(`
  CREATE TABLE IF NOT EXISTS blackjack_games (
    user_id TEXT PRIMARY KEY,
    bet INTEGER NOT NULL,
    player_cards TEXT NOT NULL,
    dealer_cards TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    updated_at INTEGER NOT NULL
  )
`).run();

// Migration safety (si ancienne DB sans "level")
safeAlter(`ALTER TABLE user_businesses ADD COLUMN level INTEGER NOT NULL DEFAULT 1`);

// Seed businesses (1 fois)
function seedBusinesses() {
  const count = db.prepare(`SELECT COUNT(*) AS c FROM businesses`).get().c;
  if (count > 0) return;

  const ins = db.prepare(`INSERT INTO businesses (name, price, income_per_hour) VALUES (?, ?, ?)`);
  ins.run("Stand 🥤", 500, 30);
  ins.run("Pizzeria 🍕", 5000, 250);
  ins.run("Supérette 🏪", 20000, 900);
  ins.run("Entreprise 🏢", 100000, 5000);
  ins.run("Groupe 🏦", 500000, 30000);
}

// =====================
// HELPERS
// =====================
function metaGet(key, fallback) {
  const row = db.prepare(`SELECT value FROM economy_meta WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}
function metaSet(key, value) {
  db.prepare(`
    INSERT INTO economy_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function nowMs() { return Date.now(); }

// Insert user if missing + read full row
function getUser(userId) {
  db.prepare(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`).run(userId);
  return db.prepare(`
    SELECT user_id, wallet, bank, has_bank, job, anti_rob_until, rob_cooldown_until, bankrob_cooldown_until, last_daily, last_monthly
    FROM users WHERE user_id = ?
  `).get(userId);
}

function updateUserFields(userId, fields) {
  // fields = { wallet: 123, bank: 0, ... }
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setSql = keys.map(k => `${k} = ?`).join(", ");
  const values = keys.map(k => fields[k]);
  values.push(userId);
  db.prepare(`UPDATE users SET ${setSql} WHERE user_id = ?`).run(...values);
}

function addWallet(userId, amount) {
  const u = getUser(userId);
  updateUserFields(userId, { wallet: u.wallet + amount });
}
function removeWallet(userId, amount) {
  const u = getUser(userId);
  updateUserFields(userId, { wallet: u.wallet - amount });
}

function addBank(userId, amount) {
  const u = getUser(userId);
  updateUserFields(userId, { bank: u.bank + amount });
}
function removeBank(userId, amount) {
  const u = getUser(userId);
  updateUserFields(userId, { bank: u.bank - amount });
}

function listBusinesses() {
  return db.prepare(`SELECT business_id, name, price, income_per_hour FROM businesses ORDER BY price ASC`).all();
}
function getBusinessById(id) {
  return db.prepare(`SELECT business_id, name, price, income_per_hour FROM businesses WHERE business_id = ?`).get(id);
}
function getUserBusinesses(userId) {
  return db.prepare(`
    SELECT b.business_id, b.name, b.price, b.income_per_hour, ub.qty, ub.level
    FROM user_businesses ub
    JOIN businesses b ON b.business_id = ub.business_id
    WHERE ub.user_id = ?
    ORDER BY b.price ASC
  `).all(userId);
}

function buyBusiness(userId, businessId) {
  const u = getUser(userId);
  const b = getBusinessById(businessId);
  if (!b) return { ok: false, msg: "Entreprise introuvable." };
  if (u.wallet < b.price) return { ok: false, msg: `Pas assez de coins. Il te manque **${b.price - u.wallet}** coins.` };

  updateUserFields(userId, { wallet: u.wallet - b.price });

  db.prepare(`
    INSERT INTO user_businesses (user_id, business_id, qty, level)
    VALUES (?, ?, 1, 1)
    ON CONFLICT(user_id, business_id) DO UPDATE SET qty = qty + 1
  `).run(userId, businessId);

  return { ok: true, business: b };
}

// ✅ Multiplicateur: +0.5 par niveau (lvl1 x1.0 -> lvl10 x5.5)
function levelMultiplier(level) {
  return 1 + 0.5 * (level - 1);
}

function calcIncomePerHourForUser(userId) {
  const rows = getUserBusinesses(userId);
  return rows.reduce((sum, r) => {
    const mult = levelMultiplier(r.level);
    const perHour = Math.floor(r.income_per_hour * r.qty * mult);
    return sum + perHour;
  }, 0);
}

function upgradeCost(basePrice, currentLevel) {
  // coût pour passer de N à N+1
  return Math.floor(basePrice * (currentLevel + 1) * 0.8);
}

// Ephemeral reply (sans deprecated)
function replyEphemeral(interaction, content) {
  return interaction.reply({ content, flags: 64 });
}

// =====================
// SETTINGS
// =====================
const DAILY_REWARD = 200;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const MONTHLY_REWARD = 1500;
const MONTHLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

// Rob system
const ROB_COOLDOWN_MS = 60 * 60 * 1000;     // 1h
const ANTIROB_DURATION_MS = 60 * 60 * 1000; // 1h
const BANKROB_COOLDOWN_MS = 60 * 60 * 1000; // 1h

const ITEM_PRICES = {
  antirob: 500,
  bank: 2000,
  job_braqueur: 3000,
};

// Slots
const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎"];
function spinSlots() {
  const a = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const b = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const c = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  return [a, b, c];
}
function computeSlotPayout(bet, [a, b, c]) {
  if (a === "💎" && b === "💎" && c === "💎") return bet * 5;
  if (a === b && b === c) return bet * 3;
  if (a === b || a === c || b === c) return bet * 2;
  return 0;
}

// =====================
// HOURLY PAYOUTS (entreprises)
// =====================
function payoutBusinesses() {
  const now = Date.now();
  const last = Number(metaGet("last_payout", "0"));
  const HOUR = 60 * 60 * 1000;

  if (last === 0) {
    metaSet("last_payout", String(now));
    return;
  }

  const hoursPassed = Math.floor((now - last) / HOUR);
  const times = Math.max(0, Math.min(hoursPassed, 24)); // limite 24h d'un coup
  if (times <= 0) return;

  const owners = db.prepare(`SELECT DISTINCT user_id FROM user_businesses WHERE qty > 0`).all();
  const upd = db.prepare(`UPDATE users SET wallet = wallet + ? WHERE user_id = ?`);

  for (const o of owners) {
    const userId = o.user_id;
    getUser(userId);
    const perHour = calcIncomePerHourForUser(userId);
    if (perHour <= 0) continue;
    upd.run(perHour * times, userId);
  }

  metaSet("last_payout", String(last + times * HOUR));
}

// =====================
// BLACKJACK
// =====================
const BJ_SUITS = ["♠️", "♥️", "♦️", "♣️"];
const BJ_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function bjDrawCard() {
  const r = BJ_RANKS[Math.floor(Math.random() * BJ_RANKS.length)];
  const s = BJ_SUITS[Math.floor(Math.random() * BJ_SUITS.length)];
  return { r, s };
}
function bjCardToString(c) {
  return `${c.r}${c.s}`;
}
function bjHandValue(cards) {
  let total = 0;
  let aces = 0;

  for (const c of cards) {
    if (c.r === "A") { total += 11; aces += 1; }
    else if (["K", "Q", "J"].includes(c.r)) total += 10;
    else total += Number(c.r);
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function bjGetGame(userId) {
  const row = db.prepare(`SELECT * FROM blackjack_games WHERE user_id = ?`).get(userId);
  if (!row) return null;
  return {
    user_id: row.user_id,
    bet: row.bet,
    player_cards: JSON.parse(row.player_cards),
    dealer_cards: JSON.parse(row.dealer_cards),
    status: row.status,
    updated_at: row.updated_at,
  };
}
function bjSaveGame(userId, bet, playerCards, dealerCards, status = "active") {
  const now = Date.now();
  db.prepare(`
    INSERT INTO blackjack_games (user_id, bet, player_cards, dealer_cards, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      bet = excluded.bet,
      player_cards = excluded.player_cards,
      dealer_cards = excluded.dealer_cards,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    userId,
    bet,
    JSON.stringify(playerCards),
    JSON.stringify(dealerCards),
    status,
    now
  );
}
function bjEndGame(userId) {
  db.prepare(`DELETE FROM blackjack_games WHERE user_id = ?`).run(userId);
}

function bjRenderState(playerCards, dealerCards, revealDealer = false) {
  const pText = playerCards.map(bjCardToString).join("  ");
  const pVal = bjHandValue(playerCards);

  let dText;
  let dValText;

  if (revealDealer) {
    dText = dealerCards.map(bjCardToString).join("  ");
    dValText = String(bjHandValue(dealerCards));
  } else {
    const first = dealerCards[0] ? bjCardToString(dealerCards[0]) : "??";
    dText = `${first}  ❓`;
    dValText = "?";
  }

  return (
    `🃏 **Blackjack**\n` +
    `👤 Toi: ${pText}  (**${pVal}**)\n` +
    `🤖 Dealer: ${dText}  (**${dValText}**)\n`
  );
}

// =====================
// ROB / BANKROB HELPERS
// =====================
function formatCooldown(ms) {
  const m = Math.ceil(ms / (60 * 1000));
  if (m <= 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h}h ${rest}min`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// =====================
// DISCORD BOT
// =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName("balance").setDescription("Voir ton argent (wallet + bank)"),

  new SlashCommandBuilder().setName("daily").setDescription("Récupérer ta récompense quotidienne"),
  new SlashCommandBuilder().setName("monthly").setDescription("Récupérer ta récompense mensuelle (1500 coins)"),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Pile ou face (mise)")
    .addIntegerOption(opt => opt.setName("mise").setDescription("Montant à miser").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("slots")
    .setDescription("Machine à sous 🎰 (mise)")
    .addIntegerOption(opt => opt.setName("mise").setDescription("Montant à miser").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Afficher le top des plus riches 🏆"),

  new SlashCommandBuilder().setName("shop").setDescription("Voir le shop des entreprises 🏪"),
  new SlashCommandBuilder()
    .setName("buy")
    .setDescription("Acheter une entreprise du shop")
    .addIntegerOption(opt => opt.setName("id").setDescription("ID de l'entreprise (dans /shop)").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("mybiz").setDescription("Voir tes entreprises et tes revenus 💼"),
  new SlashCommandBuilder()
    .setName("upgrade")
    .setDescription("Améliorer une entreprise (lvl 1 à 10) ⬆️")
    .addIntegerOption(opt => opt.setName("id").setDescription("ID de l'entreprise").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("addmoney")
    .setDescription("[Admin] Donner des coins à un joueur")
    .addUserOption(opt => opt.setName("joueur").setDescription("Joueur à créditer").setRequired(true))
    .addIntegerOption(opt => opt.setName("montant").setDescription("Nombre de coins").setRequired(true).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Donner des coins à un joueur")
    .addUserOption(opt => opt.setName("joueur").setDescription("Joueur à payer").setRequired(true))
    .addIntegerOption(opt => opt.setName("montant").setDescription("Nombre de coins").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("Démarrer une partie de Blackjack 🃏")
    .addIntegerOption(opt => opt.setName("mise").setDescription("Montant à miser").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder().setName("hit").setDescription("Blackjack: Piocher une carte"),
  new SlashCommandBuilder().setName("stand").setDescription("Blackjack: Rester et laisser jouer le dealer"),

  // ✅ NEW: shop items
  new SlashCommandBuilder()
    .setName("buyitem")
    .setDescription("Acheter: antirob | bank | job_braqueur")
    .addStringOption(opt =>
      opt.setName("item")
        .setDescription("Objet à acheter")
        .setRequired(true)
        .addChoices(
          { name: `Anti-Rob 🛡️ (${ITEM_PRICES.antirob} coins)`, value: "antirob" },
          { name: `Banque 🏦 (${ITEM_PRICES.bank} coins)`, value: "bank" },
          { name: `Job Braqueur 🥷 (${ITEM_PRICES.job_braqueur} coins)`, value: "job_braqueur" },
        )
    ),

  // ✅ NEW: deposit/withdraw
  new SlashCommandBuilder()
    .setName("deposit")
    .setDescription("Déposer des coins en banque (protégé contre /rob)")
    .addIntegerOption(opt => opt.setName("montant").setDescription("Montant").setRequired(true).setMinValue(1)),

  new SlashCommandBuilder()
    .setName("withdraw")
    .setDescription("Retirer des coins de la banque")
    .addIntegerOption(opt => opt.setName("montant").setDescription("Montant").setRequired(true).setMinValue(1)),

  // ✅ NEW: rob & bankrob
  new SlashCommandBuilder()
    .setName("rob")
    .setDescription("Voler un joueur (cooldown 1h)")
    .addUserOption(opt => opt.setName("joueur").setDescription("Victime").setRequired(true)),

  new SlashCommandBuilder()
    .setName("bankrob")
    .setDescription("Braquer la banque d'un joueur (job braqueur, cooldown 1h)")
    .addUserOption(opt => opt.setName("joueur").setDescription("Cible").setRequired(true)),
].map(c => c.toJSON());

client.once("ready", async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);

  seedBusinesses();

  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commandes enregistrées avec succès");
  } catch (error) {
    console.error("❌ Erreur enregistrement commandes :", error);
  }

  setInterval(payoutBusinesses, 60 * 1000);
  payoutBusinesses();
});

// =====================
// INTERACTIONS
// =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;

  // /balance (wallet + bank + protections)
  if (interaction.commandName === "balance") {
    const u = getUser(userId);
    const protectedTxt = u.anti_rob_until > nowMs() ? "🛡️ Anti-Rob: **ACTIF**" : "🛡️ Anti-Rob: inactif";
    const jobTxt = u.job === "braqueur" ? "🥷 Job: **Braqueur**" : "👤 Job: none";
    const bankTxt = u.has_bank ? `🏦 Banque: **${u.bank}** coins` : "🏦 Banque: non achetée";
    return interaction.reply(`💰 Wallet: **${u.wallet}** coins\n${bankTxt}\n${protectedTxt}\n${jobTxt}`);
  }

  // /daily
  if (interaction.commandName === "daily") {
    const u = getUser(userId);
    const now = Date.now();
    const elapsed = now - u.last_daily;

    if (elapsed < DAILY_COOLDOWN_MS) {
      const remaining = DAILY_COOLDOWN_MS - elapsed;
      const hours = Math.floor(remaining / (60 * 60 * 1000));
      const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
      return replyEphemeral(interaction, `⏳ Daily déjà pris ! Reviens dans **${hours}h ${minutes}min**.`);
    }

    const newWallet = u.wallet + DAILY_REWARD;
    updateUserFields(userId, { wallet: newWallet, last_daily: now });
    return interaction.reply(`🎁 Daily récupéré : **+${DAILY_REWARD}** coins ! (Total wallet: **${newWallet}**)`);
  }

  // /monthly (1500)
  if (interaction.commandName === "monthly") {
    const u = getUser(userId);
    const now = Date.now();
    const elapsed = now - u.last_monthly;

    if (elapsed < MONTHLY_COOLDOWN_MS) {
      const remaining = MONTHLY_COOLDOWN_MS - elapsed;
      const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
      const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      return replyEphemeral(interaction, `⏳ Monthly déjà pris ! Reviens dans **${days}j ${hours}h**.`);
    }

    const newWallet = u.wallet + MONTHLY_REWARD;
    updateUserFields(userId, { wallet: newWallet, last_monthly: now });
    return interaction.reply(`🗓️ Monthly récupéré : **+${MONTHLY_REWARD}** coins ! (Total wallet: **${newWallet}**)`);
  }

  // /coinflip
  if (interaction.commandName === "coinflip") {
    const bet = interaction.options.getInteger("mise", true);
    const u = getUser(userId);
    if (bet > u.wallet) return replyEphemeral(interaction, `❌ Pas assez de coins. Tu as **${u.wallet}** coins.`);

    const win = Math.random() < 0.5;
    const newWallet = win ? (u.wallet + bet) : (u.wallet - bet);
    updateUserFields(userId, { wallet: newWallet });

    return interaction.reply(
      win
        ? `🪙 **Gagné !** Tu gagnes **+${bet}** coins. Total wallet: **${newWallet}**`
        : `🪙 **Perdu...** Tu perds **-${bet}** coins. Total wallet: **${newWallet}**`
    );
  }

  // /slots
  if (interaction.commandName === "slots") {
    const bet = interaction.options.getInteger("mise", true);
    const u = getUser(userId);
    if (bet > u.wallet) return replyEphemeral(interaction, `❌ Pas assez de coins. Tu as **${u.wallet}** coins.`);

    let walletAfterBet = u.wallet - bet;
    const roll = spinSlots();
    const payout = computeSlotPayout(bet, roll);
    walletAfterBet += payout;

    updateUserFields(userId, { wallet: walletAfterBet });

    const [a, b, c] = roll;
    const line = `🎰 **[ ${a} | ${b} | ${c} ]**`;

    if (payout === 0) return interaction.reply(`${line}\n❌ Perdu… Tu perds **-${bet}** coins. Total wallet: **${walletAfterBet}**`);
    if (payout === bet * 5) return interaction.reply(`${line}\n💎💎💎 **JACKPOT !** Tu gagnes **+${payout - bet}** coins ! Total wallet: **${walletAfterBet}**`);
    if (payout === bet * 3) return interaction.reply(`${line}\n🔥 **TRIPLÉ !** Tu gagnes **+${payout - bet}** coins ! Total wallet: **${walletAfterBet}**`);
    return interaction.reply(`${line}\n✅ **Double !** Tu gagnes **+${payout - bet}** coins ! Total wallet: **${walletAfterBet}**`);
  }

  // /leaderboard
  if (interaction.commandName === "leaderboard") {
    const top = db.prepare(`
      SELECT user_id, wallet
      FROM users
      ORDER BY wallet DESC
      LIMIT 10
    `).all();

    if (!top.length) return interaction.reply("🏆 Leaderboard vide pour l’instant !");

    const lines = top.map((row, idx) => {
      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "🔸";
      return `${medal} **${idx + 1}.** <@${row.user_id}> — **${row.wallet}** coins`;
    });

    return interaction.reply(`🏆 **Leaderboard (Top 10 wallet)**\n\n${lines.join("\n")}`);
  }

  // /shop
  if (interaction.commandName === "shop") {
    const items = listBusinesses();
    const text = items
      .map(b => `**${b.business_id}.** ${b.name} — 💰 ${b.price} coins — ⏱️ +${b.income_per_hour}/h (lvl 1 = x1.0)`)
      .join("\n");
    return interaction.reply(`🏪 **Shop des entreprises**\n\n${text}\n\n➡️ Acheter : **/buy id:<numéro>**`);
  }

  // /buy (entreprises)
  if (interaction.commandName === "buy") {
    const id = interaction.options.getInteger("id", true);
    const result = buyBusiness(userId, id);
    if (!result.ok) return replyEphemeral(interaction, `❌ ${result.msg}`);

    const u = getUser(userId);
    const income = calcIncomePerHourForUser(userId);
    return interaction.reply(
      `✅ Achat réussi : **${result.business.name}**\n` +
      `💰 Wallet restant : **${u.wallet}** coins\n` +
      `📈 Tes revenus total : **${income}/h**`
    );
  }

  // /mybiz
  if (interaction.commandName === "mybiz") {
    const owned = getUserBusinesses(userId);
    if (!owned.length) return interaction.reply("💼 Tu n’as aucune entreprise. Fais **/shop** puis **/buy** !");

    const lines = owned.map(r => {
      const mult = levelMultiplier(r.level);
      const perHour = Math.floor(r.income_per_hour * r.qty * mult);
      return `• **${r.business_id}. ${r.name}** x${r.qty} — ⭐ lvl **${r.level}** (x${mult.toFixed(1)}) — ⏱️ **+${perHour}/h**`;
    }).join("\n");

    const totalIncome = calcIncomePerHourForUser(userId);
    return interaction.reply(`💼 **Tes entreprises**\n\n${lines}\n\n📈 **Revenus total : ${totalIncome}/h**\n⬆️ Upgrade : **/upgrade id:<ID>**`);
  }

  // /upgrade
  if (interaction.commandName === "upgrade") {
    const id = interaction.options.getInteger("id", true);

    const owned = db.prepare(`
      SELECT ub.qty, ub.level, b.name, b.price
      FROM user_businesses ub
      JOIN businesses b ON b.business_id = ub.business_id
      WHERE ub.user_id = ? AND ub.business_id = ?
    `).get(userId, id);

    if (!owned || owned.qty <= 0) return replyEphemeral(interaction, "❌ Tu ne possèdes pas cette entreprise. Fais **/shop** puis **/buy**.");
    if (owned.level >= 10) return replyEphemeral(interaction, "✅ Cette entreprise est déjà **niveau 10**.");

    const u = getUser(userId);
    const cost = upgradeCost(owned.price, owned.level);
    if (u.wallet < cost) return replyEphemeral(interaction, `❌ Pas assez de coins. Il te manque **${cost - u.wallet}** coins.`);

    updateUserFields(userId, { wallet: u.wallet - cost });
    db.prepare(`UPDATE user_businesses SET level = level + 1 WHERE user_id = ? AND business_id = ?`).run(userId, id);

    const newLevel = owned.level + 1;
    const mult = levelMultiplier(newLevel);
    const totalIncome = calcIncomePerHourForUser(userId);
    const newWallet = getUser(userId).wallet;

    return interaction.reply(
      `⬆️ Upgrade réussi : **${owned.name}**\n` +
      `⭐ Niveau : **${newLevel}/10** (x${mult.toFixed(1)})\n` +
      `💸 Coût : **${cost}** coins\n` +
      `💰 Wallet restant : **${newWallet}** coins\n` +
      `📈 Tes revenus total : **${totalIncome}/h**`
    );
  }

  // /addmoney (admin)
  if (interaction.commandName === "addmoney") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return replyEphemeral(interaction, "❌ Tu n’as pas la permission d’utiliser cette commande.");
    }

    const target = interaction.options.getUser("joueur", true);
    const amount = interaction.options.getInteger("montant", true);

    addWallet(target.id, amount);
    const newBal = getUser(target.id).wallet;
    return interaction.reply(`✅ **Admin** a donné **${amount}** coins à <@${target.id}>. (Nouveau wallet: **${newBal}**)`);
  }

  // /pay
  if (interaction.commandName === "pay") {
    const target = interaction.options.getUser("joueur", true);
    const amount = interaction.options.getInteger("montant", true);

    if (target.bot) return replyEphemeral(interaction, "❌ Tu ne peux pas payer un bot.");
    if (target.id === userId) return replyEphemeral(interaction, "❌ Tu ne peux pas te payer toi-même.");

    const sender = getUser(userId);
    if (sender.wallet < amount) return replyEphemeral(interaction, `❌ Pas assez de coins. Tu as **${sender.wallet}** coins.`);

    removeWallet(userId, amount);
    addWallet(target.id, amount);

    const senderNew = getUser(userId).wallet;
    return interaction.reply(`✅ <@${userId}> a envoyé **${amount}** coins à <@${target.id}>.\n💰 Ton nouveau wallet: **${senderNew}**`);
  }

  // =====================
  // ✅ NEW: /buyitem
  // =====================
  if (interaction.commandName === "buyitem") {
    const item = interaction.options.getString("item", true);
    const u = getUser(userId);

    const price = ITEM_PRICES[item];
    if (!price) return replyEphemeral(interaction, "❌ Item invalide.");

    if (u.wallet < price) return replyEphemeral(interaction, `❌ Pas assez de coins. Il te manque **${price - u.wallet}** coins.`);

    // BANK
    if (item === "bank") {
      if (u.has_bank) return replyEphemeral(interaction, "🏦 Tu as déjà une banque.");
      updateUserFields(userId, { wallet: u.wallet - price, has_bank: 1 });
      return interaction.reply(`🏦 Banque achetée ! Tu peux maintenant utiliser **/deposit** et **/withdraw**.`);
    }

    // ANTIROB
    if (item === "antirob") {
      updateUserFields(userId, {
        wallet: u.wallet - price,
        anti_rob_until: nowMs() + ANTIROB_DURATION_MS,
      });
      return interaction.reply(`🛡️ Anti-Rob activé pendant **1h** ! (bloque /rob et /bankrob)`);
    }

    // JOB BRAQUEUR
    if (item === "job_braqueur") {
      updateUserFields(userId, { wallet: u.wallet - price, job: "braqueur" });
      return interaction.reply(`🥷 Job acheté : tu es maintenant **Braqueur** ! Tu peux utiliser **/bankrob**.`);
    }
  }

  // =====================
  // ✅ NEW: /deposit
  // =====================
  if (interaction.commandName === "deposit") {
    const amount = interaction.options.getInteger("montant", true);
    const u = getUser(userId);

    if (!u.has_bank) return replyEphemeral(interaction, "🏦 Tu n’as pas de banque. Achète-la avec **/buyitem bank**.");
    if (amount > u.wallet) return replyEphemeral(interaction, `❌ Pas assez dans ton wallet. Tu as **${u.wallet}** coins.`);
    if (amount <= 0) return replyEphemeral(interaction, "❌ Montant invalide.");

    updateUserFields(userId, { wallet: u.wallet - amount, bank: u.bank + amount });
    const nu = getUser(userId);
    return interaction.reply(`🏦 Dépôt réussi : **${amount}** coins.\n💰 Wallet: **${nu.wallet}** | 🏦 Bank: **${nu.bank}**`);
  }

  // =====================
  // ✅ NEW: /withdraw
  // =====================
  if (interaction.commandName === "withdraw") {
    const amount = interaction.options.getInteger("montant", true);
    const u = getUser(userId);

    if (!u.has_bank) return replyEphemeral(interaction, "🏦 Tu n’as pas de banque.");
    if (amount > u.bank) return replyEphemeral(interaction, `❌ Pas assez en banque. Tu as **${u.bank}** coins.`);
    if (amount <= 0) return replyEphemeral(interaction, "❌ Montant invalide.");

    updateUserFields(userId, { bank: u.bank - amount, wallet: u.wallet + amount });
    const nu = getUser(userId);
    return interaction.reply(`💸 Retrait réussi : **${amount}** coins.\n💰 Wallet: **${nu.wallet}** | 🏦 Bank: **${nu.bank}**`);
  }

  // =====================
  // ✅ NEW: /rob
  // =====================
  if (interaction.commandName === "rob") {
    const target = interaction.options.getUser("joueur", true);
    if (target.bot) return replyEphemeral(interaction, "❌ Tu ne peux pas voler un bot.");
    if (target.id === userId) return replyEphemeral(interaction, "❌ Tu ne peux pas te voler toi-même.");

    const me = getUser(userId);
    const victim = getUser(target.id);

    // cooldown
    if (me.rob_cooldown_until > nowMs()) {
      const remaining = me.rob_cooldown_until - nowMs();
      return replyEphemeral(interaction, `⏳ Cooldown /rob. Reviens dans **${formatCooldown(remaining)}**.`);
    }

    // antirob
    if (victim.anti_rob_until > nowMs()) {
      updateUserFields(userId, { rob_cooldown_until: nowMs() + ROB_COOLDOWN_MS });
      return interaction.reply(`🛡️ ${target.username} est protégé par **Anti-Rob** ! Vol bloqué (cooldown 1h appliqué).`);
    }

    if (victim.wallet <= 0) {
      updateUserFields(userId, { rob_cooldown_until: nowMs() + ROB_COOLDOWN_MS });
      return interaction.reply(`😶 ${target.username} n'a rien sur lui (wallet vide).`);
    }

    // vole 10% à 35% du wallet
    const min = Math.max(1, Math.floor(victim.wallet * 0.10));
    const max = Math.max(1, Math.floor(victim.wallet * 0.35));
    const stolen = randomInt(min, max);

    updateUserFields(target.id, { wallet: victim.wallet - stolen });
    updateUserFields(userId, { wallet: me.wallet + stolen, rob_cooldown_until: nowMs() + ROB_COOLDOWN_MS });

    return interaction.reply(`🥷 Tu as volé **${stolen} coins** à ${target.username} !`);
  }

  // =====================
  // ✅ NEW: /bankrob
  // =====================
  if (interaction.commandName === "bankrob") {
    const target = interaction.options.getUser("joueur", true);
    if (target.bot) return replyEphemeral(interaction, "❌ Tu ne peux pas braquer un bot.");
    if (target.id === userId) return replyEphemeral(interaction, "❌ Tu ne peux pas te braquer toi-même.");

    const me = getUser(userId);
    const victim = getUser(target.id);

    if (me.job !== "braqueur") {
      return replyEphemeral(interaction, "❌ Tu dois être **Braqueur**. Achète le job avec **/buyitem job_braqueur**.");
    }

    // cooldown
    if (me.bankrob_cooldown_until > nowMs()) {
      const remaining = me.bankrob_cooldown_until - nowMs();
      return replyEphemeral(interaction, `⏳ Cooldown /bankrob. Reviens dans **${formatCooldown(remaining)}**.`);
    }

    // antirob bloque aussi
    if (victim.anti_rob_until > nowMs()) {
      updateUserFields(userId, { bankrob_cooldown_until: nowMs() + BANKROB_COOLDOWN_MS });
      return interaction.reply(`🛡️ ${target.username} est protégé par **Anti-Rob** ! Braquage bloqué (cooldown 1h appliqué).`);
    }

    if (!victim.has_bank || victim.bank <= 0) {
      updateUserFields(userId, { bankrob_cooldown_until: nowMs() + BANKROB_COOLDOWN_MS });
      return interaction.reply(`🏦 ${target.username} n'a pas (ou plus) d'argent en banque.`);
    }

    // braquage: 5% à 15% de la bank
    const min = Math.max(1, Math.floor(victim.bank * 0.05));
    const max = Math.max(1, Math.floor(victim.bank * 0.15));
    const stolen = randomInt(min, max);

    updateUserFields(target.id, { bank: victim.bank - stolen });
    updateUserFields(userId, { wallet: me.wallet + stolen, bankrob_cooldown_until: nowMs() + BANKROB_COOLDOWN_MS });

    return interaction.reply(`💥 Braquage réussi ! Tu as pris **${stolen} coins** dans la banque de ${target.username}.`);
  }

  // =====================
  // 🃏 BLACKJACK (TON CODE)
  // =====================
  if (interaction.commandName === "blackjack") {
    const bet = interaction.options.getInteger("mise", true);
    const u = getUser(userId);

    const existing = bjGetGame(userId);
    if (existing && existing.status === "active") {
      return replyEphemeral(interaction, "❌ Tu as déjà une partie en cours. Fais **/hit** ou **/stand**.");
    }

    if (bet > u.wallet) {
      return replyEphemeral(interaction, `❌ Pas assez de coins. Tu as **${u.wallet}** coins.`);
    }

    removeWallet(userId, bet);

    const playerCards = [bjDrawCard(), bjDrawCard()];
    const dealerCards = [bjDrawCard(), bjDrawCard()];

    bjSaveGame(userId, bet, playerCards, dealerCards, "active");

    const msg =
      bjRenderState(playerCards, dealerCards, false) +
      `\nMise: **${bet}** coins\n` +
      `👉 Choisis: **/hit** (piocher) ou **/stand** (rester)`;

    return interaction.reply(msg);
  }

  if (interaction.commandName === "hit") {
    const game = bjGetGame(userId);
    if (!game || game.status !== "active") {
      return replyEphemeral(interaction, "❌ Tu n’as pas de partie active. Lance **/blackjack mise:<...>**.");
    }

    game.player_cards.push(bjDrawCard());
    const pVal = bjHandValue(game.player_cards);

    if (pVal > 21) {
      bjEndGame(userId);
      const msg =
        bjRenderState(game.player_cards, game.dealer_cards, true) +
        `\n💥 **BUST !** Tu dépasses 21 → **Perdu**.\n` +
        `Tu perds ta mise: **${game.bet}** coins.`;
      return interaction.reply(msg);
    }

    bjSaveGame(userId, game.bet, game.player_cards, game.dealer_cards, "active");
    const msg =
      bjRenderState(game.player_cards, game.dealer_cards, false) +
      `\n👉 Choisis: **/hit** ou **/stand**`;
    return interaction.reply(msg);
  }

  if (interaction.commandName === "stand") {
    const game = bjGetGame(userId);
    if (!game || game.status !== "active") {
      return replyEphemeral(interaction, "❌ Tu n’as pas de partie active. Lance **/blackjack mise:<...>**.");
    }

    while (bjHandValue(game.dealer_cards) < 17) {
      game.dealer_cards.push(bjDrawCard());
    }

    const pVal = bjHandValue(game.player_cards);
    const dVal = bjHandValue(game.dealer_cards);

    let resultText = "";
    if (dVal > 21) {
      addWallet(userId, game.bet * 3);
      resultText = `✅ Dealer dépasse 21 (**${dVal}**) → **Gagné !**\n🏆 Gain: **+${game.bet * 3}** coins`;
    } else if (dVal > pVal) {
      resultText = `❌ Dealer (**${dVal}**) > Toi (**${pVal}**) → **Perdu**\nTu perds ta mise: **${game.bet}** coins`;
    } else if (pVal > dVal) {
      addWallet(userId, game.bet * 3);
      resultText = `✅ Toi (**${pVal}**) > Dealer (**${dVal}**) → **Gagné !**\n🏆 Gain: **+${game.bet * 3}** coins`;
    } else {
      addWallet(userId, game.bet);
      resultText = `🤝 Égalité (**${pVal}**) → **Remboursé**\n💸 Rendu: **+${game.bet}** coins`;
    }

    bjEndGame(userId);

    const newBal = getUser(userId).wallet;
    const msg =
      bjRenderState(game.player_cards, game.dealer_cards, true) +
      `\n${resultText}\n` +
      `💰 Nouveau wallet: **${newBal}** coins`;

    return interaction.reply(msg);
  }
});

client.login(process.env.TOKEN);