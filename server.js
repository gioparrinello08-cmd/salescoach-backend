// server.js — SalesCoach backend v2.5
// New: TTS streaming (faster perceived latency), 8 questions guaranteed, fallback for fillers

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

const QUESTIONS_PER_INTERVIEW = 8;

// ============================================================
// /tts — STREAMING version
// ============================================================
// We use the /stream endpoint of ElevenLabs which sends audio chunks as they're generated
// The browser can start playing before the full file is ready
app.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const elevenResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=2`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
        }),
      }
    );

    if (!elevenResponse.ok) {
      const errText = await elevenResponse.text();
      console.error('ElevenLabs error:', elevenResponse.status, errText);
      return res.status(elevenResponse.status).json({ error: 'TTS failed' });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    // Pipe ElevenLabs response stream directly to client
    if (elevenResponse.body && typeof elevenResponse.body.pipe === 'function') {
      // Node 18 native stream
      elevenResponse.body.pipe(res);
    } else {
      // Web ReadableStream — convert to Node
      const reader = elevenResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    }
  } catch (error) {
    console.error('TTS streaming error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'TTS failed' });
    } else {
      res.end();
    }
  }
});

// ============================================================
// /transcribe
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
    formData.append('response_format', 'verbose_json');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Whisper error:', response.status, errText);
      return res.status(response.status).json({ error: 'Transcription failed', details: errText });
    }

    const data = await response.json();
    res.json({ text: data.text, duration: data.duration || 0 });
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
// /generate-questions — guaranteed 8 questions
// ============================================================
app.post('/generate-questions', async (req, res) => {
  try {
    const { role, interviewType, company, cvText } = req.body;

    const companyKey = (company || '').toLowerCase().includes('salesforce') ? 'salesforce'
      : (company || '').toLowerCase().includes('google') ? 'google'
      : (company || '').toLowerCase().includes('revolut') ? 'revolut'
      : (company || '').toLowerCase().includes('stripe') ? 'stripe'
      : (company || '').toLowerCase().includes('amazon') ? 'amazon'
      : 'generic';

    const typeKey = (interviewType || '').toLowerCase().includes('hr') ? 'hr'
      : (interviewType || '').toLowerCase().includes('hiring') ? 'hiring'
      : (interviewType || '').toLowerCase().includes('role') ? 'roleplay'
      : 'hr';

    const realQuestions = QUESTIONS_DB[companyKey]?.[typeKey] || QUESTIONS_DB.generic[typeKey];

    const shuffled = [...realQuestions].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(QUESTIONS_PER_INTERVIEW, shuffled.length));

    if (cvText && cvText.trim().length > 100) {
      try {
        const adaptPrompt = `Sei un recruiter senior dell'azienda ${company}. Hai queste ${picked.length} domande standard per un colloquio di tipo "${interviewType}" per il ruolo "${role}":

${picked.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Hai anche il CV del candidato:
${cvText.slice(0, 2500)}

ADATTAMENTO: scegli LE PRIME 2-3 domande da personalizzare aggiungendo un riferimento specifico al CV del candidato (azienda, numero, esperienza precisa). Le altre LASCIALE INVARIATE.

OUTPUT: Restituisci SOLO un array JSON di ${picked.length} stringhe.`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          messages: [{ role: 'user', content: adaptPrompt }],
        });

        const text = response.content[0].text.trim();
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const adapted = JSON.parse(match[0]);
          if (adapted.length === picked.length) {
            return res.json({ questions: adapted, source: 'real_db_with_cv_adaptation' });
          }
        }
      } catch (e) {
        console.error('CV adaptation failed:', e);
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
    const cvSnippet = cvText ? `\n\nCV DEL CANDIDATO:\n${cvText.slice(0, 2500)}` : '';

    if (isGreeting) {
      const greetingPrompt = `Sei ${interviewerName}, recruiter dell'azienda ${companyName}. Stai iniziando una videochiamata di colloquio con ${candidateName}, candidato per il ruolo di ${candidateRole}.

GENERA SOLO il saluto iniziale, come faresti in una vera videochiamata.

REGOLE STRETTE:
- Italiano colloquiale ma professionale
- 2-3 frasi MAX
- Suona come una persona vera che inizia una videocall
- NON fare ancora domande di colloquio
- NON usare markdown
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
    const isLastQuestion = currentQuestionIndex + 1 >= totalQuestions;
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

    const systemPrompt = `Sei ${interviewerName}, recruiter dell'azienda ${companyName}. Stai conducendo una videochiamata di colloquio con ${candidateName}, candidato per il ruolo di ${candidateRole}.

TIPO DI COLLOQUIO: ${interviewType}
${cvSnippet}

DOMANDE PIANIFICATE (${totalQuestions} totali):
${questionTrack.map((q, i) => `${i + 1}. ${q}`).join('\n')}

STATO ATTUALE:
- Domanda ${currentQuestionIndex + 1} di ${totalQuestions}: "${currentQuestion}"
- Follow-up fatti: ${followUpCount} (max 2)
- ${isFirstQuestionAfterGreeting ? 'PRIMA domanda dopo il saluto. Introduci con: "Bene, allora partiamo. [domanda]"' : 'Conduci normalmente'}
- ULTIMA DOMANDA? ${isLastQuestion ? 'SI' : 'No'}

ULTIMA RISPOSTA DEL CANDIDATO:
"${lastUserMessage}"

REGOLE:
1. Reagisci sempre alla risposta in modo specifico
2. Tono umano, intercalari naturali ("ok", "interessante", "capisco")
3. Italiano colloquiale ma professionale
4. 2-4 frasi MAX
5. MAI markdown, asterischi
6. Sembra conversazione vocale vera

FOLLOW-UP AGGRESSIVI come un vero recruiter. Fai follow-up se la risposta:
- È vaga/generica
- Manca di esempi concreti
- Manca di numeri (per sales)
- Salta passaggi (situazione/azione/risultato)

Esempi: "Mi puoi fare un esempio?", "Quanti in numeri?", "Cosa hai fatto TU?"

DECISIONE finale:
- Risposta VAGA E meno di 2 follow-up → fai follow-up, termina con: [ACTION: follow_up]
- Risposta SOLIDA o 2 follow-up già fatti → reagisci E poni la PROSSIMA domanda (${currentQuestionIndex + 2 <= totalQuestions ? `domanda ${currentQuestionIndex + 2}: "${questionTrack[currentQuestionIndex + 1]}"` : 'NESSUNA'}). Termina con: [ACTION: next_question]

REGOLA CRITICA SU END:
- Usa [ACTION: end] SOLO se sei alla domanda ${totalQuestions} (ultima) E il candidato HA RISPOSTO con almeno una frase sostanziale
- Se ultima domanda ma risposta vaga e budget follow-up disponibile → [ACTION: follow_up]
- Se end: ringrazia e chiudi naturalmente: "Perfetto ${candidateName}, abbiamo finito. Grazie del tuo tempo, ti faremo sapere. Buona giornata!"

IMPORTANTE: il tag [ACTION: ...] è OBBLIGATORIO ma sarà rimosso dal sistema.`;

    const conversationMessages = messages.map(m => ({ role: m.role, content: m.content }));

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: conversationMessages,
    });

    let content = response.content[0].text.trim();

    let action = 'next_question';
    const actionMatch = content.match(/\[ACTION:\s*(\w+)\s*\]/i);
    if (actionMatch) action = actionMatch[1].toLowerCase();
    content = content.replace(/\[ACTION:[^\]]*\]/g, '').trim();

    if (action === 'follow_up' && followUpCount >= 2) action = 'next_question';

    if (action === 'end' && currentQuestionIndex + 1 < totalQuestions) {
      action = 'next_question';
    }

    if (action === 'end') {
      const userWords = (lastUserMessage.match(/\S+/g) || []).length;
      if (userWords < 8 && followUpCount < 2) action = 'follow_up';
    }

    res.json({ content, action });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Chat failed', details: error.message });
  }
});

// ============================================================
// /analyze-speech (unchanged from v2.4)
// ============================================================
app.post('/analyze-speech', async (req, res) => {
  try {
    const { userResponses = [] } = req.body;
    if (userResponses.length === 0) return res.json({ error: 'No responses to analyze' });

    const fillers = [
      'uhm', 'ehm', 'uh', 'eh',
      'tipo', 'cioè', 'praticamente', 'diciamo', 'ecco', 'insomma',
      'allora', 'in pratica',
      'quindi', 'appunto', 'sicuramente', 'comunque', 'infatti',
      'voglio dire', 'in poche parole', 'fondamentalmente'
    ];

    const passiveMarkers = ['è stato', 'è stata', 'sono stati', 'sono state', 'venne', 'veniva', 'vengono'];
    const activeStrong = ['ho gestito', 'ho costruito', 'ho lanciato', 'ho chiuso', 'ho ottenuto', 'ho portato', 'ho creato', 'ho guidato', 'ho coordinato', 'ho raggiunto', 'ho generato', 'ho aumentato', 'ho ridotto', 'ho ottimizzato', 'ho implementato', 'ho negoziato', 'ho convertito'];

    let totalWords = 0, totalDuration = 0, fillerCount = 0;
    let passiveCount = 0, activeCount = 0, numberMentions = 0;
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

      fillers.forEach(f => {
        const regex = new RegExp(`\\b${f}\\b`, 'gi');
        const matches = (text.match(regex) || []).length;
        fillerCount += matches;
        fillersFound[f] += matches;
      });
      passiveMarkers.forEach(p => {
        const regex = new RegExp(`\\b${p}\\b`, 'gi');
        passiveCount += (text.match(regex) || []).length;
      });
      activeStrong.forEach(a => {
        const regex = new RegExp(`\\b${a}\\b`, 'gi');
        activeCount += (text.match(regex) || []).length;
      });
      const numberMatches = text.match(/\b\d+([.,]\d+)?(%|k|m|mln|mila|mil|euro|€|\$)?\b/gi) || [];
      numberMentions += numberMatches.length;
    });

    const uniqueWords = new Set(allWords).size;
    const lexicalDiversity = totalWords > 0 ? +(uniqueWords / totalWords).toFixed(3) : 0;

    const stopwordsIT = new Set([
      'il','la','i','le','un','una','uno','di','a','da','in','con','su','per','tra','fra',
      'e','o','ma','che','non','è','ho','hai','ha','sono','sei','siamo','siete','c\'è',
      'mi','ti','si','ci','vi','lo','gli','ne','molto','poi','anche','quando','come','dove',
      'cosa','solo','già','tutto','tutti','sempre','questo','questa','quello','quella',
      'noi','voi','loro','io','tu','lui','lei',
    ]);
    const wordFreq = {};
    allWords.forEach(w => {
      const wl = w.toLowerCase();
      if (wl.length < 4 || stopwordsIT.has(wl)) return;
      wordFreq[wl] = (wordFreq[wl] || 0) + 1;
    });
    const topRepeated = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 5).filter(([w, c]) => c >= 3);

    const wpm = totalDuration > 0 ? Math.round((totalWords / totalDuration) * 60) : 0;
    const avgResponseDuration = userResponses.length > 0 ? +(totalDuration / userResponses.length).toFixed(1) : 0;
    const topFillers = Object.entries(fillersFound).filter(([f, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);

    let starDetection = null;
    try {
      const transcript = userResponses.map((r, i) => `RISPOSTA ${i + 1}: ${r.text}`).join('\n\n');
      const starPrompt = `Analizza queste risposte di un candidato. Valuta se seguono il metodo STAR.

${transcript}

OUTPUT JSON:
{
  "star_score": <1-10>,
  "responses_using_star": <numero>,
  "comment": "<1 frase italiano>"
}`;

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: starPrompt }],
      });
      const text = response.content[0].text.trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) starDetection = JSON.parse(match[0]);
    } catch (e) { console.error('STAR detection error:', e); }

    res.json({
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
    });
  } catch (error) {
    console.error('Speech analysis error:', error);
    res.status(500).json({ error: 'Speech analysis failed', details: error.message });
  }
});

// ============================================================
// /generate-report
// ============================================================
app.post('/generate-report', async (req, res) => {
  try {
    const { messages = [], name = '', role = '', speechAnalysis = null } = req.body;
    const transcript = messages.map(m => `${m.role === 'assistant' ? 'INTERVISTATORE' : 'CANDIDATO'}: ${m.content}`).join('\n\n');

    const speechSection = speechAnalysis ? `

DATI OGGETTIVI DEL PARLATO:
- Parole totali: ${speechAnalysis.total_words}
- Durata media risposta: ${speechAnalysis.avg_response_duration_sec}s (target 60-90s)
- Velocità: ${speechAnalysis.words_per_minute} wpm (target 130-160)
- Riempitivi: ${speechAnalysis.filler_count} (densità ${speechAnalysis.filler_density_pct}%)
- Top riempitivi: ${speechAnalysis.top_fillers?.map(f => `"${f.word}" (${f.count}x)`).join(', ') || 'nessuno'}
- Diversità lessicale: ${speechAnalysis.lexical_diversity}
- Numeri/dati citati: ${speechAnalysis.number_mentions}
- Verbi attivi forti: ${speechAnalysis.active_verb_count}
- Marker passivi: ${speechAnalysis.passive_marker_count}
- STAR score: ${speechAnalysis.star_detection?.star_score || 'N/A'}/10

USA QUESTI DATI per feedback SPECIFICO.` : '';

    const prompt = `Analizza la trascrizione del colloquio e genera un report del candidato ${name} (ruolo: ${role}).

TRASCRIZIONE:
${transcript}
${speechSection}

REPORT JSON:
{
  "voto": <1-10>,
  "chiarezza": <1-10>,
  "struttura": <1-10>,
  "confidenza": <1-10>,
  "punti_forza": ["...", "...", "..."],
  "miglioramenti": ["...", "...", "..."],
  "consiglio": "..."
}

REGOLE:
- 3 punti di forza specifici
- 3 miglioramenti concreti
- 1 consiglio azionabile
- Tutto in italiano
- SOLO JSON`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Invalid report format' });

    const report = JSON.parse(match[0]);
    if (speechAnalysis) report.speech = speechAnalysis;
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
  res.json({ status: 'ok', service: 'SalesCoach backend v2.5', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SalesCoach backend v2.5 listening on 0.0.0.0:${PORT}`);
});
