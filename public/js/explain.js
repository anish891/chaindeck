// "What does this mean?" explanations. Any element with data-explain="key" gets a small help button;
// clicking it opens a popover with a plain-language explanation in English or Hindi.
// All text here is static and authored by us; it is inserted as text, never as HTML.

import { icon } from './icons.js';

const LANG_KEY = 'cd_explain_lang';

const EXPLAIN = {
  regime: {
    en: ['Composite Market Regime', 'One label that combines several readings (gamma exposure, PCR, CPR width, IV skew and where spot sits against max pain) into the kind of day it looks like, such as rangebound or trending. "Signal agreement" shows how many of those readings point the same way. It describes conditions; it is not a forecast.'],
    hi: ['कंपोज़िट मार्केट रिजीम', 'कई संकेतों (गामा एक्सपोज़र, PCR, CPR की चौड़ाई, IV स्क्यू और मैक्स पेन के मुकाबले स्पॉट की जगह) को मिलाकर एक लेबल बनता है जो बताता है कि दिन कैसा दिख रहा है, जैसे रेंज में या ट्रेंडिंग। "Signal agreement" बताता है कि कितने संकेत एक ही दिशा में हैं। यह मौजूदा हालात का विवरण है, भविष्यवाणी नहीं।']
  },
  tradeSetup: {
    en: ['Live Trade Setup', 'An automatic summary of today\'s key levels from CPR, the zero-gamma level, PCR changes and the straddle range. The "target" and "invalidation" are levels where the current reading would be confirmed or would stop holding. They are calculated, not recommendations, so always decide trades yourself.'],
    hi: ['लाइव ट्रेड सेटअप', 'CPR, ज़ीरो-गामा लेवल, PCR में बदलाव और स्ट्रैडल रेंज से आज के मुख्य लेवल का अपने-आप बना सारांश। "Target" और "Invalidation" वे लेवल हैं जहाँ मौजूदा रीडिंग सही साबित होगी या टूट जाएगी। ये गणना हैं, सलाह नहीं, इसलिए ट्रेड का फ़ैसला हमेशा खुद करें।']
  },
  smartFlow: {
    en: ['Smart Money Flow', 'Flags strikes where volume or open interest jumped far above that strike\'s own recent pace. A sudden burst at one strike can mean a large player is building or closing a position there. It only scores changes between back-to-back snapshots, so gaps in data do not create false alarms.'],
    hi: ['स्मार्ट मनी फ़्लो', 'उन स्ट्राइक को दिखाता है जहाँ वॉल्यूम या ओपन इंटरेस्ट उस स्ट्राइक की अपनी हाल की रफ़्तार से बहुत ज़्यादा उछला। किसी एक स्ट्राइक पर अचानक तेज़ी का मतलब हो सकता है कि कोई बड़ा खिलाड़ी वहाँ पोज़ीशन बना या काट रहा है। यह सिर्फ़ लगातार स्नैपशॉट के बीच का बदलाव गिनता है, ताकि डेटा में गैप से गलत अलर्ट न आए।']
  },
  straddleCalc: {
    en: ['ATM Straddle and Expected Move', 'The straddle is the price of the at-the-money call plus the put. It is what the market charges for movement until expiry, so about 0.85 times the straddle is a rough one-standard-deviation move by expiry. If the straddle falls through the day, option premium is decaying; if it rises, the market expects more movement.'],
    hi: ['ATM स्ट्रैडल और अनुमानित मूव', 'स्ट्रैडल = एट-द-मनी कॉल + पुट की कीमत। यह वह कीमत है जो बाज़ार एक्सपायरी तक हलचल के लिए लेता है, इसलिए स्ट्रैडल का लगभग 0.85 गुना एक्सपायरी तक का अनुमानित मूव (एक स्टैंडर्ड डेविएशन) है। दिन में स्ट्रैडल गिरे तो प्रीमियम घट रहा है; बढ़े तो बाज़ार ज़्यादा हलचल की उम्मीद कर रहा है।']
  },
  impliedProb: {
    en: ['Market-Implied Expiry Probability', 'Option prices across strikes can be turned into the probability the market assigns to each closing level at expiry. The tallest part of the curve is the most likely zone according to current prices. It reflects what option buyers and sellers are paying for, not what will happen.'],
    hi: ['बाज़ार के हिसाब से एक्सपायरी की संभावना', 'अलग-अलग स्ट्राइक की ऑप्शन कीमतों से यह निकाला जा सकता है कि बाज़ार एक्सपायरी पर हर क्लोज़िंग लेवल को कितनी संभावना दे रहा है। कर्व का सबसे ऊँचा हिस्सा मौजूदा कीमतों के हिसाब से सबसे संभावित ज़ोन है। यह बताता है कि बाज़ार किस चीज़ की कीमत दे रहा है, यह नहीं कि क्या होगा।']
  },
  mlTrend: {
    en: ['Intraday Trend and Breakout Scoring', 'A score built from gamma exposure, PCR, IV skew, CPR type, distance from max pain and unusual flow. It estimates whether the next 15 to 30 minutes look more like a breakout or a range. Treat it as one input among many.'],
    hi: ['इंट्राडे ट्रेंड और ब्रेकआउट स्कोर', 'गामा एक्सपोज़र, PCR, IV स्क्यू, CPR टाइप, मैक्स पेन से दूरी और असामान्य फ़्लो से बना स्कोर। यह अनुमान लगाता है कि अगले 15 से 30 मिनट ब्रेकआउट जैसे दिखते हैं या रेंज जैसे। इसे कई संकेतों में से एक मानें।']
  },
  expectedRange: {
    en: ['Expected Range', 'Spot plus and minus the expected move (about 0.85 times the ATM straddle). Price stays inside this band to expiry roughly two times out of three if options are fairly priced.'],
    hi: ['अनुमानित रेंज', 'स्पॉट के ऊपर और नीचे अनुमानित मूव (ATM स्ट्रैडल का लगभग 0.85 गुना)। अगर ऑप्शन की कीमत सही है तो लगभग तीन में से दो बार कीमत एक्सपायरी तक इस दायरे में रहती है।']
  },
  pcr: {
    en: ['PCR (Put-Call Ratio)', 'Total put open interest divided by total call open interest. Above 1 means more puts are open, often because writers are selling puts and expect support; below 1 means calls dominate. "Near" uses only strikes close to the money and "Vol" uses traded volume instead of OI.'],
    hi: ['PCR (पुट-कॉल रेशियो)', 'कुल पुट ओपन इंटरेस्ट ÷ कुल कॉल ओपन इंटरेस्ट। 1 से ऊपर मतलब ज़्यादा पुट खुले हैं, अक्सर इसलिए कि राइटर पुट बेच रहे हैं और सपोर्ट की उम्मीद रखते हैं; 1 से नीचे मतलब कॉल ज़्यादा हैं। "Near" सिर्फ़ ATM के पास की स्ट्राइक लेता है और "Vol" OI की जगह ट्रेड हुआ वॉल्यूम।']
  },
  ivSkew: {
    en: ['IV Skew (25 delta risk reversal)', 'The implied volatility of an out-of-the-money put minus that of an equally out-of-the-money call. A positive number means downside protection costs more, which is normal for indices; a sharp rise means traders are paying up for crash protection. The badge compares today\'s ATM IV with recent sessions or India VIX.'],
    hi: ['IV स्क्यू (25 डेल्टा रिस्क रिवर्सल)', 'आउट-ऑफ़-द-मनी पुट की इम्प्लाइड वोलैटिलिटी माइनस उतने ही दूर की कॉल की IV। पॉज़िटिव का मतलब गिरावट से बचाव महँगा है, जो इंडेक्स में आम है; अचानक बढ़ना मतलब ट्रेडर गिरावट से सुरक्षा के लिए ज़्यादा पैसा दे रहे हैं। बैज आज की ATM IV को पिछले सेशन या India VIX से मिलाता है।']
  },
  oiVelocity: {
    en: ['Open Interest and Velocity', 'Open interest is the number of option contracts still open. Rising call OI usually means call writers are adding positions (resistance); rising put OI usually means put writers are adding (support). RoC shows how fast total OI changed in the last 5 and 15 minutes.'],
    hi: ['ओपन इंटरेस्ट और रफ़्तार', 'ओपन इंटरेस्ट यानी कितने ऑप्शन कॉन्ट्रैक्ट अभी खुले हैं। कॉल OI बढ़ना आमतौर पर कॉल राइटर की नई पोज़ीशन (रेज़िस्टेंस) है; पुट OI बढ़ना पुट राइटर की (सपोर्ट)। RoC बताता है कि पिछले 5 और 15 मिनट में कुल OI कितनी तेज़ी से बदला।']
  },
  maxPain: {
    en: ['Max Pain', 'The expiry level at which option buyers as a group would lose the most, and option writers would pay out the least. Price sometimes drifts toward it near expiry, especially on quiet days, but it is a tendency, not a rule.'],
    hi: ['मैक्स पेन', 'एक्सपायरी का वह लेवल जहाँ ऑप्शन खरीदारों को कुल मिलाकर सबसे ज़्यादा नुकसान और ऑप्शन राइटर को सबसे कम भुगतान होगा। एक्सपायरी के पास, खासकर शांत दिनों में, कीमत कभी-कभी इसकी तरफ़ खिसकती है, लेकिन यह झुकाव है, नियम नहीं।']
  },
  walls: {
    en: ['Call and Put Walls', 'Strikes with the largest open interest. A big call wall often acts as resistance because writers there want price to stay below it; a big put wall often acts as support. Strength is that strike\'s share of all call or put OI. Walls can shift during the day, so watch the OI change view.'],
    hi: ['कॉल और पुट वॉल', 'सबसे ज़्यादा ओपन इंटरेस्ट वाली स्ट्राइक। बड़ी कॉल वॉल अक्सर रेज़िस्टेंस का काम करती है क्योंकि वहाँ के राइटर चाहते हैं कि कीमत उसके नीचे रहे; बड़ी पुट वॉल अक्सर सपोर्ट बनती है। Strength उस स्ट्राइक का कुल कॉल या पुट OI में हिस्सा है। वॉल दिन में खिसक सकती हैं, इसलिए OI change देखते रहें।']
  },
  cpr: {
    en: ['Central Pivot Range (CPR)', 'Three levels (pivot, top and bottom) calculated from the previous session\'s high, low and close, plus support and resistance levels S1, S2, R1, R2. A narrow CPR often comes before a trending day; a wide CPR often comes before a sideways day.'],
    hi: ['सेंट्रल पिवट रेंज (CPR)', 'पिछले सेशन के हाई, लो और क्लोज़ से बने तीन लेवल (पिवट, टॉप और बॉटम), साथ में सपोर्ट और रेज़िस्टेंस S1, S2, R1, R2। पतला CPR अक्सर ट्रेंडिंग दिन से पहले आता है; चौड़ा CPR अक्सर साइडवेज़ दिन से पहले।']
  },
  gex: {
    en: ['Gamma Exposure (GEX)', 'An estimate of how much option dealers must buy or sell to stay hedged as price moves. Positive GEX means their hedging pushes against moves, which tends to calm the market; negative GEX means hedging adds to moves, which can make swings sharper. Shown in crores of rupees per 1% move.'],
    hi: ['गामा एक्सपोज़र (GEX)', 'अनुमान कि कीमत हिलने पर हेज बनाए रखने के लिए ऑप्शन डीलरों को कितना खरीदना या बेचना पड़ेगा। पॉज़िटिव GEX में उनकी हेजिंग मूव के उलट जाती है, जिससे बाज़ार शांत रहता है; नेगेटिव GEX में हेजिंग मूव को बढ़ाती है, जिससे झटके तेज़ हो सकते हैं। 1% मूव पर करोड़ रुपये में।']
  },
  zeroGamma: {
    en: ['Zero-Gamma Level', 'The spot level where total gamma exposure flips from positive to negative. Above it the market tends to be calmer; below it moves can speed up. Distance shows how far spot is from the flip.'],
    hi: ['ज़ीरो-गामा लेवल', 'वह स्पॉट लेवल जहाँ कुल गामा एक्सपोज़र पॉज़िटिव से नेगेटिव हो जाता है। इसके ऊपर बाज़ार आमतौर पर शांत रहता है; इसके नीचे मूव तेज़ हो सकते हैं। Distance बताता है कि स्पॉट इस लेवल से कितना दूर है।']
  },
  similarSessions: {
    en: ['Sessions That Looked Like Today', 'Compares today\'s mix of PCR, gamma regime, CPR width, IV skew and OI changes with saved past sessions and lists the closest matches. Use it to recall how similar days played out; it fills up as more sessions are saved.'],
    hi: ['आज जैसे पिछले सेशन', 'आज के PCR, गामा रिजीम, CPR चौड़ाई, IV स्क्यू और OI बदलाव को सेव किए गए पिछले सेशन से मिलाकर सबसे मिलते-जुलते दिन दिखाता है। इससे याद आता है कि ऐसे दिन कैसे बीते; जितने ज़्यादा सेशन सेव होंगे, यह उतना बेहतर होगा।']
  },
  priceChart: {
    en: ['Price, Levels and Patterns', 'NIFTY candles with the support and resistance zones drawn as shaded bands (green below price, red above; darker means stronger). The orange line is VWAP, the bars along the bottom are volume and the blue bars on the right are the volume profile, showing where most trading happened. Arrows mark candlestick and chart patterns. NIFTY itself has no volume, so volume comes from the Nifty 50 ETF (NIFTYBEES) as a proxy. Candles come from Yahoo Finance, which is unofficial and delayed.'],
    hi: ['प्राइस, लेवल और पैटर्न', 'NIFTY की कैंडल, उन पर सपोर्ट और रेज़िस्टेंस ज़ोन शेड वाले बैंड के रूप में (भाव के नीचे हरा, ऊपर लाल; जितना गहरा उतना मज़बूत)। नारंगी लाइन VWAP है, नीचे के बार वॉल्यूम हैं और दाईं ओर के नीले बार वॉल्यूम प्रोफ़ाइल हैं, जो दिखाते हैं कि सबसे ज़्यादा ट्रेडिंग कहाँ हुई। तीर कैंडलस्टिक और चार्ट पैटर्न दिखाते हैं। NIFTY इंडेक्स का अपना वॉल्यूम नहीं होता, इसलिए वॉल्यूम के लिए Nifty 50 ETF (NIFTYBEES) को प्रॉक्सी की तरह लिया गया है। कैंडल Yahoo Finance से आती हैं, जो अनऑफ़िशियल और देरी वाली है।']
  },
  levelLadder: {
    en: ['Support and Resistance Ladder', 'Every price level that matters, merged into zones. A zone is stronger when several different kinds of evidence land in the same place: big option OI walls, yesterday\'s and last week\'s highs and lows, CPR and pivots, VWAP, volume peaks, swing highs and lows, max pain, the zero-gamma level and round numbers. Status shows whether price has touched the zone today (held means it bounced, broken means it closed through). Strength is a score out of 100, not a probability.'],
    hi: ['सपोर्ट और रेज़िस्टेंस सीढ़ी', 'हर ज़रूरी प्राइस लेवल, जिन्हें ज़ोन में मिलाया गया है। ज़ोन तब मज़बूत होता है जब अलग-अलग तरह के संकेत एक ही जगह मिलें: बड़े ऑप्शन OI वॉल, कल और पिछले हफ़्ते के हाई-लो, CPR और पिवट, VWAP, वॉल्यूम के शिखर, स्विंग हाई-लो, मैक्स पेन, ज़ीरो-गामा लेवल और गोल अंक। स्टेटस बताता है कि आज भाव ने ज़ोन को छुआ या नहीं (held मतलब वहाँ से लौटा, broken मतलब उसके पार बंद हुआ)। स्ट्रेंथ 100 में से एक स्कोर है, संभावना नहीं।']
  },
  signals: {
    en: ['Reversal Signals', 'A signal appears only when a candlestick or chart pattern forms on the latest candles. It is scored out of 100 from four kinds of evidence: the pattern itself, whether it formed at a strong zone, whether volume expanded, and whether option OI supports it (put writing for bullish, call writing for bearish). A signal needs at least two kinds to agree before it is called confirmed. Trigger is the level that confirms the idea, invalid is where the idea is wrong, and target is the nearest zone in the opposite direction. The history line shows how this pattern actually performed on past data, which is often no better than chance.'],
    hi: ['रिवर्सल सिग्नल', 'सिग्नल तभी दिखता है जब ताज़ा कैंडल पर कोई कैंडलस्टिक या चार्ट पैटर्न बने। इसे 100 में से चार तरह के सबूतों पर स्कोर मिलता है: पैटर्न खुद, क्या वह मज़बूत ज़ोन पर बना, क्या वॉल्यूम बढ़ा, और क्या ऑप्शन OI साथ देता है (तेज़ी के लिए पुट राइटिंग, मंदी के लिए कॉल राइटिंग)। कन्फ़र्म्ड कहलाने के लिए कम से कम दो तरह के सबूत एक राय में होने चाहिए। ट्रिगर वह लेवल है जो विचार की पुष्टि करता है, इनवैलिड वह जहाँ विचार गलत साबित होता है, और टारगेट उल्टी दिशा का सबसे पास का ज़ोन। हिस्ट्री वाली लाइन बताती है कि यह पैटर्न पुराने डेटा पर कैसा चला, जो अक्सर संयोग से बेहतर नहीं होता।']
  },
  actionZones: {
    en: ['Buying and selling interest zones', 'Price areas where at least two kinds of evidence agree that buyers or sellers are likely to be active: the level itself, option positioning (put writing under price, call writing above), heavy traded volume, and a price reaction such as a reversal pattern or a bounce today. This is evidence consistent with buying or selling pressure. No data source tells who actually bought or sold, so treat it as a map of where to pay attention, not a guarantee.'],
    hi: ['खरीद और बिकवाली की रुचि के ज़ोन', 'वे प्राइस एरिया जहाँ कम से कम दो तरह के सबूत बताते हैं कि खरीदार या बिकवाल सक्रिय हो सकते हैं: लेवल खुद, ऑप्शन पोज़ीशनिंग (भाव के नीचे पुट राइटिंग, ऊपर कॉल राइटिंग), भारी ट्रेडेड वॉल्यूम, और भाव की प्रतिक्रिया जैसे रिवर्सल पैटर्न या आज का उछाल। यह खरीद या बिकवाली के दबाव से मेल खाने वाला सबूत है। कोई डेटा स्रोत यह नहीं बताता कि असल में किसने खरीदा या बेचा, इसलिए इसे ध्यान देने की जगहों का नक्शा मानें, गारंटी नहीं।']
  },
  patternStats: {
    en: ['How reliable are these patterns?', 'Each pattern was scanned across the last 60 sessions of intraday candles (or five years of daily candles). For every occurrence, we entered at the next candle\'s open and checked the close a fixed number of candles later. Baseline is how often any random candle moved the same way, so a pattern only matters if it beats that. The verdict says "edge" only when there are at least 30 samples and the lower end of the 95 percent confidence range is above the baseline. Most patterns show no clear edge, and that is a useful finding.'],
    hi: ['ये पैटर्न कितने भरोसेमंद हैं?', 'हर पैटर्न को पिछले 60 सेशन की इंट्राडे कैंडल (या पाँच साल की डेली कैंडल) पर जाँचा गया। हर बार अगली कैंडल के ओपन पर एंट्री मानकर तय कैंडल बाद का क्लोज़ देखा गया। बेसलाइन बताती है कि कोई भी आम कैंडल कितनी बार उसी दिशा में चली, इसलिए पैटर्न तभी मायने रखता है जब वह इसे हराए। वर्डिक्ट में "edge" तभी आता है जब कम से कम 30 सैंपल हों और 95 प्रतिशत कॉन्फ़िडेंस रेंज का निचला सिरा बेसलाइन से ऊपर हो। ज़्यादातर पैटर्न में कोई साफ़ बढ़त नहीं दिखती, और यह भी काम की जानकारी है।']
  },
  forwardLog: {
    en: ['Live track record', 'Every confirmed signal and buying or selling zone is saved the moment it appears, then scored against what price actually did. A signal wins if price gets 1R in its favour (R is the distance from the trigger to the invalidation level) before touching the invalidation level, and is stopped out if the invalidation comes first. A fair coin would win 50 percent of decided trades, so the verdict says "edge so far" only with at least 30 decided trades and a confidence range that stays above 50 percent. Zones count as held if price moved one ATR away from them before closing through. This is the real test of the option-chain evidence, which cannot be backtested because past option chains are not available. It needs a few weeks of market days before the numbers mean much.'],
    hi: ['लाइव ट्रैक रिकॉर्ड', 'हर कन्फ़र्म्ड सिग्नल और खरीद या बिकवाली का ज़ोन दिखते ही सेव हो जाता है, फिर देखा जाता है कि भाव ने असल में क्या किया। सिग्नल तब जीतता है जब भाव इनवैलिड लेवल छूने से पहले उसके पक्ष में 1R चला जाए (R यानी ट्रिगर से इनवैलिड लेवल तक की दूरी), और इनवैलिड पहले छू जाए तो स्टॉप आउट माना जाता है। सही सिक्का तय हुए ट्रेड में 50 प्रतिशत जीतता है, इसलिए वर्डिक्ट में "edge so far" तभी आता है जब कम से कम 30 तय ट्रेड हों और कॉन्फ़िडेंस रेंज 50 प्रतिशत से ऊपर रहे। ज़ोन तब "held" माना जाता है जब भाव उसके पार बंद होने से पहले एक ATR दूर चला जाए। ऑप्शन चेन के सबूत की यही असली परीक्षा है, क्योंकि पुरानी ऑप्शन चेन उपलब्ध न होने से उसका बैकटेस्ट नहीं हो सकता। आँकड़ों का मतलब बनने में कुछ हफ़्तों के बाज़ार दिन लगेंगे।']
  },
  oiStructure: {
    en: ['OI Structure by Strike', 'Call and put open interest at each strike. Tall bars are walls. Switch the view to see how OI changed since yesterday or over the last 5, 15 or 30 minutes, which shows where new positions are being built right now. Click a bar to open that strike\'s history.'],
    hi: ['स्ट्राइक के हिसाब से OI ढाँचा', 'हर स्ट्राइक पर कॉल और पुट ओपन इंटरेस्ट। ऊँचे बार वॉल हैं। व्यू बदलकर देखें कि कल से या पिछले 5, 15 या 30 मिनट में OI कैसे बदला, इससे पता चलता है कि अभी नई पोज़ीशन कहाँ बन रही हैं। किसी बार पर क्लिक करके उस स्ट्राइक का इतिहास खोलें।']
  },
  rollingStraddle: {
    en: ['Rolling ATM Straddle', 'The ATM call plus put premium at every snapshot, always using whichever strike is at the money at that moment. A steadily falling line means premium is decaying, which suits option sellers; a rising line means the market is pricing in more movement. The dashed lines show the day\'s first value and the running average.'],
    hi: ['रोलिंग ATM स्ट्रैडल', 'हर स्नैपशॉट पर ATM कॉल + पुट प्रीमियम, उस समय जो भी स्ट्राइक एट-द-मनी हो। लगातार गिरती लाइन मतलब प्रीमियम घट रहा है, जो ऑप्शन बेचने वालों के पक्ष में है; बढ़ती लाइन मतलब बाज़ार ज़्यादा हलचल की कीमत लगा रहा है। डैश वाली लाइनें दिन की पहली वैल्यू और चलता औसत दिखाती हैं।']
  },
  ivRv: {
    en: ['IV vs Realised Volatility', 'Implied volatility (IV) is the movement option prices are charging for. Realised volatility (RV) is how much NIFTY actually moved over the last 15, 30 or 60 minutes. When IV sits well above RV, options are expensive relative to recent movement; when RV catches up with IV, they are not. IV is converted to trading hours so the two compare fairly. IV percentile ranks today\'s IV against saved session closes.'],
    hi: ['IV बनाम रियलाइज़्ड वोलैटिलिटी', 'इम्प्लाइड वोलैटिलिटी (IV) वह हलचल है जिसकी कीमत ऑप्शन ले रहे हैं। रियलाइज़्ड वोलैटिलिटी (RV) बताती है कि पिछले 15, 30 या 60 मिनट में NIFTY असल में कितना हिला। IV, RV से काफ़ी ऊपर हो तो हाल की हलचल के मुकाबले ऑप्शन महँगे हैं; RV, IV के करीब आ जाए तो नहीं। दोनों की सही तुलना के लिए IV को ट्रेडिंग घंटों के हिसाब से बदला गया है। IV percentile आज की IV को सेव किए गए सेशन से मिलाकर रैंक देता है।']
  },
  timeline: {
    en: ['Intraday Timeline', 'Spot through the day with one other measure on the right axis, from snapshots saved about once a minute. Use it to see whether PCR, IV, GEX or OI moved together with price or against it.'],
    hi: ['इंट्राडे टाइमलाइन', 'पूरे दिन का स्पॉट और दाईं तरफ़ कोई एक और पैमाना, लगभग हर मिनट सेव हुए स्नैपशॉट से। इससे देखें कि PCR, IV, GEX या OI कीमत के साथ चले या उलटे।']
  },
  buildup: {
    en: ['Buildup colours', 'Each option is labelled by how its open interest and price moved together over the last few snapshots (or since yesterday when there is no recent change). For calls: long buildup is price up with OI up, short buildup is price down with OI up, long unwinding is price down with OI down, short covering is price up with OI down. For puts the labels are read from NIFTY\'s side, so the colours mean the same thing on both sides: put writing (put price down, OI up) shows as long buildup and fresh put buying (put price up, OI up) shows as short buildup. Green is bullish for NIFTY, red is bearish.'],
    hi: ['बिल्डअप के रंग', 'हर ऑप्शन को इस आधार पर लेबल किया जाता है कि पिछले कुछ स्नैपशॉट में (या हाल में बदलाव न हो तो कल से) उसका ओपन इंटरेस्ट और कीमत साथ में कैसे बदले। कॉल के लिए: लॉन्ग बिल्डअप = कीमत ऊपर, OI ऊपर; शॉर्ट बिल्डअप = कीमत नीचे, OI ऊपर; लॉन्ग अनवाइंडिंग = कीमत नीचे, OI नीचे; शॉर्ट कवरिंग = कीमत ऊपर, OI नीचे। पुट के लेबल NIFTY के नज़रिए से पढ़े जाते हैं, ताकि दोनों तरफ़ रंगों का मतलब एक ही रहे: पुट राइटिंग (पुट की कीमत नीचे, OI ऊपर) लॉन्ग बिल्डअप दिखती है और नई पुट खरीद (पुट की कीमत ऊपर, OI ऊपर) शॉर्ट बिल्डअप। हरा NIFTY के लिए तेज़ी, लाल मंदी।']
  },
  greeks: {
    en: ['Option Greeks', 'Delta is roughly how much the option price moves for a 1 point move in NIFTY, and also a rough chance of finishing in the money. Theta is how much value the option loses per day from time decay, all else equal.'],
    hi: ['ऑप्शन ग्रीक्स', 'डेल्टा लगभग बताता है कि NIFTY के 1 पॉइंट हिलने पर ऑप्शन की कीमत कितनी हिलेगी, और मोटे तौर पर इन-द-मनी खत्म होने की संभावना भी। थीटा बताता है कि बाकी सब वैसा ही रहे तो समय बीतने से ऑप्शन रोज़ कितनी वैल्यू खोता है।']
  },
  sectors: {
    en: ['Sector Heatmap', 'Today\'s percentage change for the main NSE sector indices, greener for gains and redder for losses. When banks and financials move together, NIFTY usually follows, because they are its biggest weight. Each tile also shows how many of that sector\'s stocks are up and down.'],
    hi: ['सेक्टर हीटमैप', 'मुख्य NSE सेक्टर इंडेक्स का आज का प्रतिशत बदलाव, बढ़त हरे में और गिरावट लाल में। जब बैंक और फ़ाइनेंशियल साथ चलते हैं तो NIFTY अक्सर उनके पीछे चलता है, क्योंकि इंडेक्स में उनका वज़न सबसे ज़्यादा है। हर टाइल यह भी दिखाती है कि उस सेक्टर के कितने शेयर ऊपर और कितने नीचे हैं।']
  },
  breadth: {
    en: ['Market Breadth', 'How many of the 50 NIFTY stocks are up versus down today. A rise led by only a few heavyweights with most stocks falling is weaker than a broad rise.'],
    hi: ['मार्केट ब्रेड्थ', 'आज NIFTY के 50 शेयरों में से कितने ऊपर और कितने नीचे हैं। अगर सिर्फ़ कुछ बड़े शेयरों के दम पर तेज़ी हो और ज़्यादातर शेयर गिर रहे हों, तो वह चौड़ी तेज़ी से कमज़ोर मानी जाती है।']
  },
  participants: {
    en: ['FII / DII Positions', 'NSE publishes, every evening, how many index futures and options contracts each type of trader holds: FIIs (foreign institutions), DIIs (domestic institutions such as mutual funds), Pro (brokers trading their own money) and Client (mostly retail). Long % in index futures is the share of their futures that are long; FIIs below about 30% are heavily short, above about 70% heavily long. Net change is versus the previous trading day.'],
    hi: ['FII / DII पोज़ीशन', 'NSE हर शाम बताता है कि हर तरह के ट्रेडर के पास कितने इंडेक्स फ़्यूचर्स और ऑप्शन कॉन्ट्रैक्ट हैं: FII (विदेशी संस्थान), DII (घरेलू संस्थान जैसे म्यूचुअल फ़ंड), Pro (अपने पैसे से ट्रेड करने वाले ब्रोकर) और Client (ज़्यादातर रिटेल)। इंडेक्स फ़्यूचर्स में Long % बताता है कि उनके फ़्यूचर्स का कितना हिस्सा लॉन्ग है; FII का लगभग 30% से नीचे होना भारी शॉर्ट और 70% से ऊपर भारी लॉन्ग माना जाता है। Net change पिछले ट्रेडिंग दिन के मुकाबले है।']
  }
};

let lang = 'en';
try { lang = localStorage.getItem(LANG_KEY) === 'hi' ? 'hi' : 'en'; } catch (e) { /* storage unavailable */ }

let pop = null;
let openKey = null;
let anchor = null;

function buildPopover() {
  pop = document.createElement('div');
  pop.className = 'explain-pop';
  pop.setAttribute('role', 'dialog');
  pop.hidden = true;
  pop.innerHTML = `
    <div class="explain-pop-head">
      <strong class="explain-pop-title"></strong>
      <div class="explain-lang" role="group" aria-label="Language">
        <button type="button" data-lang="en">English</button>
        <button type="button" data-lang="hi">हिन्दी</button>
      </div>
      <button type="button" class="explain-close" aria-label="Close">${icon('x')}</button>
    </div>
    <p class="explain-pop-body"></p>`;
  document.body.append(pop);

  pop.addEventListener('click', e => {
    const langBtn = e.target.closest('[data-lang]');
    if (langBtn) {
      lang = langBtn.dataset.lang;
      try { localStorage.setItem(LANG_KEY, lang); } catch (err) { /* ignore */ }
      fill();
      place();
      return;
    }
    if (e.target.closest('.explain-close')) close();
  });
}

function fill() {
  const entry = EXPLAIN[openKey];
  if (!entry) return;
  const [title, body] = entry[lang] || entry.en;
  pop.querySelector('.explain-pop-title').textContent = title;
  const p = pop.querySelector('.explain-pop-body');
  p.textContent = body;
  p.lang = lang;
  pop.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}

function place() {
  if (!anchor || pop.hidden) return;
  const gutter = 16;
  const r = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - gutter * 2);
  pop.style.width = `${width}px`;
  const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, gutter), window.innerWidth - width - gutter);
  const below = r.bottom + 8;
  const h = pop.offsetHeight;
  const top = below + h > window.innerHeight - gutter && r.top - 8 - h > gutter ? r.top - 8 - h : below;
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${top + window.scrollY}px`;
}

function open(key, btn) {
  if (!pop) buildPopover();
  if (openKey === key && !pop.hidden) { close(); return; }
  openKey = key;
  anchor = btn;
  fill();
  pop.hidden = false;
  place();
  btn.setAttribute('aria-expanded', 'true');
}

function close() {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  openKey = null;
  anchor = null;
}

/** Add a help button to every [data-explain] element (safe to call again after new markup appears). */
export function hydrateExplain(root = document) {
  root.querySelectorAll('[data-explain]').forEach(el => {
    const key = el.dataset.explain;
    if (!EXPLAIN[key] || el.querySelector(':scope > .explain-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'explain-btn';
    btn.dataset.explainKey = key;
    btn.setAttribute('aria-label', `What is ${EXPLAIN[key].en[0]}?`);
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'What does this mean?';
    btn.innerHTML = icon('help');
    el.append(btn);
  });
}

export function initExplain() {
  hydrateExplain();
  document.addEventListener('click', e => {
    const btn = e.target.closest('.explain-btn');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      open(btn.dataset.explainKey, btn);
      return;
    }
    if (pop && !pop.hidden && !pop.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', () => place());
}
