// server.js — SalesCoach backend v2.3
// New: real questions database, /analyze-speech endpoint, richer report

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const QUESTIONS_DB = require('./interview-questions.js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage() });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ============================================================
// /tts
// ============================================================
app.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('ElevenLabs error:', response.status, errText);
      return res.status(response.status).json({ error: 'TTS failed' });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'TTS failed' });
  }
});

// ============================================================
// /transcribe (also returns duration for speech analysis)
// ============================================================
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing audio file' });
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    formData.append('file', blob, req.file.originalname || 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'it');
    // Get verbose_json to also return duration
    formData.append('response_format', 'verbose_json');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI Whisper error:', response.status, errText);
      return res.status(response.status).json({ error: 'Transcription failed', details: errText });
    }

    const data = await response.json();
    res.json({
      text: data.text,
      duration: data.duration || 0, // seconds of audio
    });
  } catch (error) {
    console.error('Transcribe error:', error);
    res.status(500).json({ error: 'Transcription failed', details: error.message });
  }
});

// ============================================================
// /parse-cv
// ============================================================
app.post('/parse-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

    let pdfParse;
    try {
      pdfParse = require('pdf-parse/lib/pdf-parse.js');
    } catch (e) {
      console.error('pdf-parse import error:', e);
      return res.status(500).json({ error: 'PDF parser not available' });
    }

    const data = await pdfParse(req.file.buffer);

    if (!data || !data.text || data.text.trim().length < 10) {
      return res.json({ text: '', warning: 'Could not extract meaningful text from PDF.' });
    }

    res.json({ text: data.text });
  } catch (error) {
    console.error('CV parse error:', error);
    res.json({ text: '', error: error.message });
  }
});

// ============================================================
// /generate-questions — NOW pulls from real questions database
// ============================================================
app.post('/generate-questions', async (req, res) => {
  try {
    const { role, interviewType, company, cvText } = req.body;

    // Map company name to DB key
    const companyKey = (company || '').toLowerCase().includes('salesforce') ? 'salesforce'
      : (company || '').toLowerCase().includes('google') ? 'google'
      : (company || '').toLowerCase().includes('revolut') ? 'revolut'
      : (company || '').toLowerCase().includes('stripe') ? 'stripe'
      : (company || '').toLowerCase().includes('amazon') ? 'amazon'
      : 'generic';

    // Map interview type to DB key
    const typeKey = (interviewType || '').toLowerCase().includes('hr') ? 'hr'
      : (interviewType || '').toLowerCase().includes('hiring') ? 'hiring'
      : (interviewType || '').toLowerCase().includes('role') ? 'roleplay'
      : 'hr';

    const realQuestions = QUESTIONS_DB[companyKey]?.[typeKey] || QUESTIONS_DB.generic[typeKey];

    // Pick 5 random questions from the real pool
    const shuffled = [...realQuestions].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(5, shuffled.length));

    // If we have CV text, ask Claude to lightly adapt 1-2 questions to make them CV-specific
    if (cvText && cvText.trim().length > 100) {
      try {
        const adaptPrompt = `Sei un recruiter senior dell'azienda ${company}. Hai queste 5 domande standard per un colloquio di tipo "${interviewType}" per il ruolo "${role}":

${picked.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Hai anche il CV del candidato:
${cvText.slice(0, 2500)}

ADATTAMENTO: scegli LE PRIME 2 domande da personalizzare aggiungendo un riferimento specifico al CV del candidato (azienda, numero, esperienza precisa). Le altre 3 domande LASCIALE INVARIATE perché sono autentiche.

Per le 2 domande adattate, mantieni il senso originale, ma rendile più specifiche al candidato. Esempio:
- Originale: "Raccontami di un momento in cui hai gestito una pipeline complessa"
- Adattata: "Nel tuo ruolo ad Amazon hai gestito 2.000+ lead. Come hai prioritizzato le opportunità in pipeline?"

OUTPUT: Restituisci SOLO un array JSON di 5 stringhe, niente altro.`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          messages: [{ role: 'user', content: adaptPrompt }],
        });

        const text = response.content[0].text.trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const adapted = JSON.parse(match[0]);
          if (adapted.length === 5) {
            return res.json({ questions: adapted, source: 'real_db_with_cv_adaptation' });
          }
        }
      } catch (e) {
        console.error('CV adaptation failed, returning raw questions:', e);
      }
    }

    res.json({ questions: picked, source: 'real_db' });
  } catch (error) {
    console.error('Generate questions error:', error);
    res.json({ questions: [] });
  }
});

// ============================================================
// /chat
// ============================================================
app.post('/chat', async (req, res) => {
  try {
    const {
      messages = [],
      candidateName = '',
      candidateRole = '',
      cvText = '',
      companyName = '',
      interviewerName = '',
      interviewType = '',
      questionTrack = [],
      currentQuestionIndex = 0,
      followUpCount = 0,
      isGreeting = false,
    } = req.body;

    const totalQuestions = questionTrack.length;
    const currentQuestion = questionTrack[currentQuestionIndex] || '';
    const cvSnippet = cvText ? `\n\nCV DEL CANDIDATO (per riferimenti specifici):\n${cvText.slice(0, 2500)}` : '';

    if (isGreeting) {
      const greetingPrompt = `Sei ${interviewerName}, recruiter dell'azienda ${companyName}. Stai iniziando una videochiamata di colloquio con ${candidateName}, candidato per il ruolo di ${candidateRole}.

GENERA SOLO il saluto iniziale, come faresti in una vera videochiamata. Esempio di tono naturale:
"Ciao ${candidateName}, ben trovato. Sono ${interviewerName} di ${companyName}, piacere di conoscerti. Allora, come va? Pronto per iniziare?"

REGOLE STRETTE:
- Italiano colloquiale ma professionale
- 2-3 frasi MAX
- Suona come una persona vera che inizia una videocall
- NON fare ancora domande di colloquio
- NON usare markdown, elenchi, asterischi
- Termina con qualcosa che inviti il candidato a rispondere`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: greetingPrompt }],
      });

      let content = response.content[0].text.trim();
      content = content.replace(/\[ACTION:[^\]]*\]/g, '').trim();

      return res.json({ content, action: 'greeting' });
    }

    const isFirstQuestionAfterGreeting = messages.filter(m => m.role === 'assistant').length === 1;

    const systemPrompt = `Sei ${interviewerName}, recruiter dell'azienda ${companyName}. Stai conducendo una videochiamata di colloquio con ${candidateName}, candidato per il ruolo di ${candidateRole}.

TIPO DI COLLOQUIO: ${interviewType}
${cvSnippet}

DOMANDE PIANIFICATE PER QUESTO COLLOQUIO (in ordine):
${questionTrack.map((q, i) => `${i + 1}. ${q}`).join('\n')}

STATO ATTUALE:
- Stai trattando la domanda ${currentQuestionIndex + 1} di ${totalQuestions}: "${currentQuestion}"
- Hai già fatto ${followUpCount} follow-up su questa domanda (massimo 2)
- ${isFirstQuestionAfterGreeting ? 'Il candidato ha appena risposto al tuo saluto. Devi ora introdurre la prima domanda con una transizione naturale, tipo "Bene, allora partiamo. [domanda 1]"' : 'Stai conducendo il colloquio normalmente'}

REGOLE DI COMPORTAMENTO:
1. Reagisci sempre alla risposta del candidato in modo specifico (cita qualcosa che ha detto)
2. Mantieni un tono umano, non robotico — ogni tanto usa intercalari naturali ("ok perfetto", "interessante", "capisco", "bene")
3. Italiano colloquiale ma professionale
4. 2-4 frasi totali
5. MAI markdown, elenchi puntati, asterischi
6. Sembra una vera conversazione vocale, non un testo scritto

DECISIONE — alla fine della tua risposta, decidi cosa fare:
- Se la risposta del candidato è VAGA, INCOMPLETA o INTERESSANTE da approfondire E hai fatto meno di 2 follow-up → fai un follow-up specifico e termina con: [ACTION: follow_up]
- Se la risposta è SOLIDA o hai già fatto 2 follow-up → reagisci brevemente E poni la PROSSIMA domanda della lista (${currentQuestionIndex + 2 <= totalQuestions ? `domanda ${currentQuestionIndex + 2}: "${questionTrack[currentQuestionIndex + 1]}"` : 'NESSUNA - colloquio finito'}). Termina con: [ACTION: next_question]
- Se hai appena posto l'ULTIMA domanda (${currentQuestionIndex + 1} di ${totalQuestions}) e ricevi la risposta finale → reagisci brevemente, ringrazia il candidato, fai un saluto di chiusura naturale tipo "Perfetto ${candidateName}, abbiamo finito. Grazie davvero del tuo tempo, ti faremo sapere a breve. Buona giornata!" E termina con: [ACTION: end]

IMPORTANTE: il tag [ACTION: ...] alla fine è OBBLIGATORIO ma non deve apparire nel testo letto al candidato — sarà rimosso dal sistema.`;

    const conversationMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: conversationMessages,
    });

    let content = response.content[0].text.trim();

    let action = 'next_question';
    const actionMatch = content.match(/\[ACTION:\s*(\w+)\s*\]/i);
    if (actionMatch) {
      action = actionMatch[1].toLowerCase();
    }
    content = content.replace(/\[ACTION:[^\]]*\]/g, '').trim();

    if (action === 'follow_up' && followUpCount >= 2) {
      action = 'next_question';
    }

    if (action === 'next_question' && currentQuestionIndex + 1 >= totalQuestions) {
      action = 'end';
    }

    res.json({ content, action });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Chat failed', details: error.message });
  }
});

// ============================================================
// /analyze-speech — NEW — deep analysis of candidate's speech
// ============================================================
// Input: array of user responses with their durations (seconds)
// Output: rich speech analytics
app.post('/analyze-speech', async (req, res) => {
  try {
    const { userResponses = [] } = req.body;
    // userResponses = [{ text: "...", duration: 12.4 }, ...]

    if (userResponses.length === 0) {
      return res.json({ error: 'No responses to analyze' });
    }

    // ---- 1. Compute deterministic metrics (no AI) ----

    const fillers = ['uhm', 'ehm', 'uh', 'eh', 'tipo', 'cioè', 'praticamente', 'diciamo', 'ecco', 'insomma', 'allora', 'in pratica'];
    const passiveMarkers = ['è stato', 'è stata', 'sono stati', 'sono state', 'è stato fatto', 'è stata fatta', 'venne', 'veniva', 'vengono'];
    const activeStrong = ['ho gestito', 'ho costruito', 'ho lanciato', 'ho chiuso', 'ho ottenuto', 'ho portato', 'ho creato', 'ho guidato', 'ho coordinato', 'ho raggiunto', 'ho generato', 'ho aumentato', 'ho ridotto', 'ho ottimizzato'];

    let totalWords = 0;
    let totalDuration = 0;
    let fillerCount = 0;
    let passiveCount = 0;
    let activeCount = 0;
    let numberMentions = 0;
    let allWords = [];

    const fillersFound = {};
    fillers.forEach(f => { fillersFound[f] = 0; });

    userResponses.forEach(r => {
      const text = (r.text || '').toLowerCase();
      const duration = r.duration || 0;
      totalDuration += duration;

      const words = text.match(/\b[\w']+\b/g) || [];
      totalWords += words.length;
      allWords = allWords.concat(words);

      // Count fillers (whole word match)
      fillers.forEach(f => {
        const regex = new RegExp(`\\b${f}\\b`, 'gi');
        const matches = (text.match(regex) || []).length;
        fillerCount += matches;
        fillersFound[f] += matches;
      });

      // Count passive structures
      passiveMarkers.forEach(p => {
        const regex = new RegExp(`\\b${p}\\b`, 'gi');
        passiveCount += (text.match(regex) || []).length;
      });

      // Count strong active verbs
      activeStrong.forEach(a => {
        const regex = new RegExp(`\\b${a}\\b`, 'gi');
        activeCount += (text.match(regex) || []).length;
      });

      // Count numbers/percentages mentioned (very useful for sales!)
      const numberMatches = text.match(/\b\d+([.,]\d+)?(%|k|m|mln|mila|mil|euro|€|\$)?\b/gi) || [];
      numberMentions += numberMatches.length;
    });

    // Lexical diversity (Type-Token Ratio): unique words / total words
    const uniqueWords = new Set(allWords).size;
    const lexicalDiversity = totalWords > 0 ? +(uniqueWords / totalWords).toFixed(3) : 0;

    // Top 5 most repeated content words (skip stopwords)
    const stopwordsIT = new Set([
      'il','la','i','le','un','una','uno','di','a','da','in','con','su','per','tra','fra',
      'e','o','ma','che','non','è','ho','hai','ha','sono','sei','siamo','siete','c\'è',
      'mi','ti','si','ci','vi','lo','gli','ne',
      'molto','poi','anche','quando','come','dove','cosa','solo','già','tutto','tutti','sempre',
      'questo','questa','quello','quella','noi','voi','loro','io','tu','lui','lei',
    ]);
    const wordFreq = {};
    allWords.forEach(w => {
      const wl = w.toLowerCase();
      if (wl.length < 4) return;
      if (stopwordsIT.has(wl)) return;
      wordFreq[wl] = (wordFreq[wl] || 0) + 1;
    });
    const topRepeated = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .filter(([w, c]) => c >= 3); // only if repeated 3+ times

    // Speaking rate: words per minute
    const wpm = totalDuration > 0 ? Math.round((totalWords / totalDuration) * 60) : 0;

    // Average response duration
    const avgResponseDuration = userResponses.length > 0
      ? +(totalDuration / userResponses.length).toFixed(1)
      : 0;

    // Top 3 fillers actually used
    const topFillers = Object.entries(fillersFound)
      .filter(([f, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // ---- 2. Use Claude for STAR detection (qualitative) ----

    let starDetection = null;
    try {
      const transcript = userResponses
        .map((r, i) => `RISPOSTA ${i + 1}: ${r.text}`)
        .join('\n\n');

      const starPrompt = `Analizza queste risposte di un candidato a un colloquio. Per ognuna, valuta se segue il metodo STAR (Situation, Task, Action, Result) tipico delle risposte comportamentali ben strutturate.

${transcript}

OUTPUT: Restituisci SOLO un JSON con questa struttura:
{
  "star_score": <numero 1-10>,
  "responses_using_star": <numero di risposte su ${userResponses.length} che seguono STAR>,
  "comment": "<breve commento di 1 frase>"
}

REGOLE:
- "star_score" 1-3: nessuna risposta strutturata, vaga
- "star_score" 4-6: alcune risposte con cenni di struttura
- "star_score" 7-10: la maggior parte delle risposte segue STAR
- Il "comment" deve essere in italiano, 1 frase`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: starPrompt }],
      });

      const text = response.content[0].text.trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        starDetection = JSON.parse(match[0]);
      }
    } catch (e) {
      console.error('STAR detection error:', e);
    }

    // ---- 3. Build response ----

    const analysis = {
      total_words: totalWords,
      total_duration_sec: +totalDuration.toFixed(1),
      avg_response_duration_sec: avgResponseDuration,
      words_per_minute: wpm,
      filler_count: fillerCount,
      filler_density_pct: totalWords > 0 ? +((fillerCount / totalWords) * 100).toFixed(1) : 0,
      top_fillers: topFillers.map(([f, c]) => ({ word: f, count: c })),
      lexical_diversity: lexicalDiversity,
      top_repeated_words: topRepeated.map(([w, c]) => ({ word: w, count: c })),
      number_mentions: numberMentions,
      active_verb_count: activeCount,
      passive_marker_count: passiveCount,
      star_detection: starDetection,
    };

    res.json(analysis);
  } catch (error) {
    console.error('Speech analysis error:', error);
    res.status(500).json({ error: 'Speech analysis failed', details: error.message });
  }
});

// ============================================================
// /generate-report — UPDATED to incorporate speech analysis
// ============================================================
app.post('/generate-report', async (req, res) => {
  try {
    const { messages = [], name = '', role = '', speechAnalysis = null } = req.body;

    const transcript = messages
      .map(m => `${m.role === 'assistant' ? 'INTERVISTATORE' : 'CANDIDATO'}: ${m.content}`)
      .join('\n\n');

    const speechSection = speechAnalysis ? `

DATI OGGETTIVI DEL PARLATO (calcolati automaticamente):
- Parole totali pronunciate: ${speechAnalysis.total_words}
- Durata media risposta: ${speechAnalysis.avg_response_duration_sec}s (target ottimale: 60-90s)
- Velocità eloquio: ${speechAnalysis.words_per_minute} parole/minuto (target: 130-160)
- Riempitivi totali: ${speechAnalysis.filler_count} (densità ${speechAnalysis.filler_density_pct}%)
- Top riempitivi usati: ${speechAnalysis.top_fillers?.map(f => `"${f.word}" (${f.count}x)`).join(', ') || 'nessuno'}
- Diversità lessicale: ${speechAnalysis.lexical_diversity} (più alto = vocabolario più ricco)
- Numeri/dati citati: ${speechAnalysis.number_mentions} (CRUCIALE per ruoli sales)
- Verbi attivi forti: ${speechAnalysis.active_verb_count}
- Marker passivi: ${speechAnalysis.passive_marker_count}
- STAR score: ${speechAnalysis.star_detection?.star_score || 'N/A'}/10
${speechAnalysis.top_repeated_words?.length > 0 ? `- Parole ripetute eccessivamente: ${speechAnalysis.top_repeated_words.map(w => `"${w.word}" (${w.count}x)`).join(', ')}` : ''}

USA QUESTI DATI per dare feedback SPECIFICO e CONCRETO. Es: se ci sono molti riempitivi, citalo. Se mancano numeri, sottolinealo (è critico per sales).` : '';

    const prompt = `Analizza la seguente trascrizione di un colloquio di lavoro e genera un report di valutazione del candidato ${name} (ruolo target: ${role}).

TRASCRIZIONE:
${transcript}
${speechSection}

GENERA UN REPORT JSON con questa struttura ESATTA:
{
  "voto": <numero 1-10>,
  "chiarezza": <numero 1-10>,
  "struttura": <numero 1-10>,
  "confidenza": <numero 1-10>,
  "punti_forza": ["...", "...", "..."],
  "miglioramenti": ["...", "...", "..."],
  "consiglio": "..."
}

REGOLE:
- Ogni voto è un intero da 1 a 10
- 3 punti di forza specifici (cita esempi dalla trascrizione e/o numeri dei dati parlato)
- 3 aree di miglioramento concrete (cita riempitivi specifici, mancanza di numeri, struttura debole, ecc.)
- 1 consiglio finale azionabile (1-2 frasi)
- Tutto in italiano
- SOLO JSON, niente altro`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Invalid report format' });

    const report = JSON.parse(match[0]);

    // Attach the raw speech analysis to the report so the frontend can show graphs
    if (speechAnalysis) {
      report.speech = speechAnalysis;
    }

    res.json(report);
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ error: 'Report generation failed' });
  }
});

// ============================================================
// Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SalesCoach backend v2.3', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SalesCoach backend v2.3 listening on 0.0.0.0:${PORT}`);
});
