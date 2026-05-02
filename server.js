const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const PDFParser = require('pdf2json');
require('dotenv').config({ path: '../.env' });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL';

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage() });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/chat', async (req, res) => {
  try {
    const {
      messages,
      candidateName,
      candidateRole,
      cvText,
      companyName,
      interviewerName,
      interviewType,
      questionTrack,        // array delle 5 domande "guida"
      currentQuestionIndex, // 0-based, quale domanda della track stiamo affrontando
      followUpCount,        // quanti follow-up gia' fatti su questa domanda
    } = req.body;

    const totalQuestions = (questionTrack && questionTrack.length) || 5;
    const safeIndex = Math.min(Math.max(currentQuestionIndex || 0, 0), totalQuestions - 1);
    const currentQ = (questionTrack && questionTrack[safeIndex]) || '';
    const remainingQs = (questionTrack && questionTrack.slice(safeIndex + 1)) || [];
    const isLastQuestion = safeIndex >= totalQuestions - 1;
    const fuCount = followUpCount || 0;
    const maxFollowUpsReached = fuCount >= 2;

    const system = `Sei ${interviewerName || 'un intervistatore esperto'}, recruiter senior di ${companyName || 'una azienda tech'} specializzata in sales e fintech. Stai conducendo un colloquio di tipo "${interviewType || 'HR'}" con ${candidateName || 'il candidato'} che punta al ruolo di ${candidateRole || 'sales'}.${cvText ? `\n\nCV del candidato (estratto):\n${cvText.slice(0, 800)}` : ''}

DOMANDA CORRENTE che stai esplorando (#${safeIndex + 1}/${totalQuestions}):
"${currentQ}"

${remainingQs.length > 0 ? `Domande successive in programma (NON anticiparle):\n${remainingQs.map((q, i) => `${safeIndex + 2 + i}. ${q}`).join('\n')}` : 'Questa e\' l\'ultima domanda della traccia.'}

REGOLE DI CONDOTTA:
- Parli in italiano, tono professionale ma umano. Conversazionale, mai robotico.
- Niente markdown, niente liste puntate, niente titoli. Solo prosa naturale, 2-4 frasi per turno.
- Reagisci sempre in modo specifico a quello che il candidato ha appena detto: cita un dettaglio, riconosci un punto, mostra che hai ascoltato.

DECISIONE A OGNI TURNO:
Dopo ogni risposta del candidato, devi decidere UNA di queste tre azioni:

1. FOLLOW_UP - Approfondisci la domanda corrente con una domanda di scavo. Usa quando:
   - la risposta e' vaga, generica o senza esempi concreti
   - il candidato ha menzionato qualcosa di interessante che merita approfondimento (un numero, un cliente, una situazione)
   - manca un elemento chiave (risultato misurabile, contesto, ruolo personale del candidato)
   ${maxFollowUpsReached ? '- ATTENZIONE: hai gia\' fatto 2 follow-up su questa domanda, NON puoi fare altri follow_up. Passa a NEXT_QUESTION o END.' : `- Hai gia' fatto ${fuCount} follow-up su questa domanda (max 2).`}

2. NEXT_QUESTION - Passa alla prossima domanda della traccia. Usa quando:
   - la risposta e' soddisfacente e completa
   - hai gia' scavato abbastanza (2 follow-up max)
   - ${isLastQuestion ? 'NON disponibile: questa e\' l\'ultima domanda, usa END.' : 'ci sono ancora domande in programma'}

3. END - Concludi il colloquio con un saluto professionale. Usa quando:
   - ${isLastQuestion ? 'sei sull\'ultima domanda E la risposta e\' soddisfacente o hai gia\' scavato' : 'NON ancora disponibile, ci sono ancora domande'}

FORMATO DI RISPOSTA OBBLIGATORIO:
Devi rispondere ESATTAMENTE in questo formato, su due righe:

[ACTION: follow_up|next_question|end]
<la tua battuta naturale al candidato>

Esempi:
[ACTION: follow_up]
Interessante che tu abbia chiuso quel deal da 50K. Mi racconti piu' nel dettaglio come hai gestito l'obiezione sul prezzo? Cosa hai detto esattamente?

[ACTION: next_question]
Capito, hai una struttura chiara sul discovery. Cambiamo argomento: ${remainingQs[0] || ''}

[ACTION: end]
Bene ${candidateName || ''}, abbiamo coperto tutto quello che mi serviva. Grazie per il tempo, ti faremo sapere nei prossimi giorni. In bocca al lupo.`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system,
      messages,
    });

    let raw = response.content[0].text.trim();

    // Parse action tag
    let action = 'next_question'; // safe default
    const actionMatch = raw.match(/^\[ACTION:\s*(follow_up|next_question|end)\]/i);
    if (actionMatch) {
      action = actionMatch[1].toLowerCase();
      raw = raw.replace(actionMatch[0], '').trim();
    }

    // Safety: se il modello dice follow_up ma cap raggiunto, forza avanzamento
    if (action === 'follow_up' && maxFollowUpsReached) {
      action = isLastQuestion ? 'end' : 'next_question';
    }
    // Safety: se il modello dice next_question sull'ultima domanda, converti in end
    if (action === 'next_question' && isLastQuestion) {
      action = 'end';
    }

    // Cleanup residual markdown / artefatti
    const text = raw
      .replace(/\*\*/g, '').replace(/\*/g, '').replace(/^#+\s*/gm, '')
      .replace(/---/g, '').replace(/^:\s*/gm, '')
      .replace(/\n{3,}/g, '\n\n').trim();

    res.json({ content: text, action });
  } catch (error) {
    console.error('CHAT ERROR:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-questions', async (req, res) => {
  try {
    const { role, interviewType, company, cvText } = req.body;
    const cvContext = cvText ? `\n\nCV del candidato:\n${cvText.slice(0, 2000)}` : '';
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `Sei un esperto recruiter di ${company || 'una azienda tech'} in ambito sales e fintech. Genera esattamente 5 domande di colloquio in italiano per un candidato che punta al ruolo di "${role}". Tipo: ${interviewType}.${cvContext ? ' Personalizza le domande in base al CV del candidato.' : ''} Rispondi SOLO con un array JSON valido senza testo aggiuntivo, senza backtick, senza markdown: ["domanda1","domanda2","domanda3","domanda4","domanda5"]${cvContext}`,
      messages: [{ role: 'user', content: 'Genera le domande.' }],
    });
    let text = response.content[0].text.trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) text = text.substring(start, end + 1);
    const questions = JSON.parse(text);
    res.json({ questions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/parse-cv', upload.single('cv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });
    const pdfParser = new PDFParser();
    pdfParser.on('pdfParser_dataReady', (data) => {
      try {
        const text = data.Pages
          .flatMap(page => page.Texts)
          .map(t => {
            try { return decodeURIComponent(t.R.map(r => r.T).join('')); }
            catch { return t.R.map(r => r.T).join(''); }
          })
          .join(' ')
          .slice(0, 3000);
        res.json({ text });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    pdfParser.on('pdfParser_dataError', (err) => {
      res.status(500).json({ error: err.message });
    });
    pdfParser.parseBuffer(req.file.buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Testo mancante' });
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 500),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      return res.status(response.status).json({ error: `ElevenLabs: ${errBody}` });
    }
    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (error) {
    console.error('TTS ERROR:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-report', async (req, res) => {
  try {
    const { messages, name, role } = req.body;
    const conversazione = messages
      .map(m => `${m.role === 'user' ? 'Candidato' : 'Intervistatore'}: ${m.content}`)
      .join('\n');
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: `Sei un coach esperto in sales e fintech. Rispondi SOLO con JSON puro, nessun testo aggiuntivo, nessun backtick, nessun markdown. Solo il JSON che inizia con { e finisce con }.
Formato obbligatorio:
{"voto":8,"chiarezza":7,"struttura":8,"confidenza":9,"punti_forza":["punto1","punto2","punto3"],"miglioramenti":["punto1","punto2","punto3"],"consiglio":"Una frase di consiglio pratico."}
Tutti i valori numerici sono interi da 1 a 10.`,
      messages: [{
        role: 'user',
        content: `Analizza questo colloquio e restituisci SOLO il JSON:\n\n${conversazione}\n\nIl candidato si chiama ${name} e punta al ruolo di ${role}.`
      }],
    });
    let text = response.content[0].text.trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('JSON non trovato: ' + text);
    text = text.substring(start, end + 1);
    const report = JSON.parse(text);
    res.json(report);
  } catch (error) {
    console.error('REPORT ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));