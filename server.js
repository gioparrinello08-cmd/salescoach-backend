// server.js — SalesCoach backend v2.2
// Fixes: pdf-parse import bug, more robust error handling on /parse-cv

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

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
    res.json({ text: data.text });
  } catch (error) {
    console.error('Transcribe error:', error);
    res.status(500).json({ error: 'Transcription failed', details: error.message });
  }
});

// ============================================================
// /parse-cv — FIXED: lazy-load pdf-parse to avoid debug-mode crash
// ============================================================
// pdf-parse has a bug where if you require() it at the top level,
// it tries to load a test PDF from disk that doesn't exist on Railway,
// crashing the import. Loading it lazily (only when called) avoids this.
app.post('/parse-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

    // Lazy-load pdf-parse here, not at top of file
    let pdfParse;
    try {
      pdfParse = require('pdf-parse/lib/pdf-parse.js');
    } catch (e) {
      console.error('pdf-parse import error:', e);
      return res.status(500).json({ error: 'PDF parser not available' });
    }

    const data = await pdfParse(req.file.buffer);

    if (!data || !data.text || data.text.trim().length < 10) {
      return res.json({ text: '', warning: 'Could not extract meaningful text from PDF (might be a scanned image).' });
    }

    res.json({ text: data.text });
  } catch (error) {
    console.error('CV parse error:', error);
    // Fallback: return empty text instead of 500, so frontend can continue
    res.json({ text: '', error: error.message });
  }
});

// ============================================================
// /generate-questions
// ============================================================
app.post('/generate-questions', async (req, res) => {
  try {
    const { role, interviewType, company, cvText } = req.body;

    const cvSection = cvText
      ? `\n\nCV DEL CANDIDATO:\n${cvText.slice(0, 3000)}\n\nLe domande devono fare riferimento DIRETTO a esperienze, aziende e numeri presenti nel CV.`
      : '';

    const prompt = `Sei un recruiter senior dell'azienda ${company}. Devi generare 5 domande per un colloquio di tipo "${interviewType}" per il ruolo di "${role}".${cvSection}

REGOLE:
- Domande in italiano
- Ogni domanda deve essere realistica, come quelle di un colloquio vero
- Tono professionale ma cordiale, come una persona vera
- Mai elenchi puntati o markdown
- Ogni domanda è UNA frase, max 2 frasi
- Le domande devono progredire dal generico (introduzione) allo specifico (situazionale/comportamentale)

OUTPUT FORMAT:
Restituisci SOLO un array JSON di 5 stringhe, niente altro. Esempio:
["domanda 1", "domanda 2", "domanda 3", "domanda 4", "domanda 5"]`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return res.json({ questions: [] });

    const questions = JSON.parse(match[0]);
    res.json({ questions });
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
- Termina con qualcosa che inviti il candidato a rispondere (es. "come va?", "tutto bene?", "pronto?")`;

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
4. 2-4 frasi totali (sei una persona, non un narratore)
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
// /generate-report
// ============================================================
app.post('/generate-report', async (req, res) => {
  try {
    const { messages = [], name = '', role = '' } = req.body;

    const transcript = messages
      .map(m => `${m.role === 'assistant' ? 'INTERVISTATORE' : 'CANDIDATO'}: ${m.content}`)
      .join('\n\n');

    const prompt = `Analizza la seguente trascrizione di un colloquio di lavoro e genera un report di valutazione del candidato ${name} (ruolo target: ${role}).

TRASCRIZIONE:
${transcript}

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
- 3 punti di forza specifici (cita esempi dalla trascrizione)
- 3 aree di miglioramento concrete
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
  res.json({ status: 'ok', service: 'SalesCoach backend v2.2', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`SalesCoach backend v2.2 listening on 0.0.0.0:${PORT}`);
});
