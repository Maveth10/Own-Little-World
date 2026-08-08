import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) return null;

  const url = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "AxonAI-App/1.0",
        "x-wait-for-model": "true"
      },
      body: JSON.stringify({ inputs: text.slice(0, 300), options: { wait_for_model: true } }),
      signal: controller.signal,
      cache: "no-store"
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
      if (Array.isArray(result) && typeof result[0] === 'number') return result;
    }
  } catch (err) {
    console.warn("Hugging Face timeout na czacie:", err.message);
  }

  return null;
}

// INTELIGENTNA ROTACJA MODELI GOOGLE GEMINI Z WIZJĄ
async function callGeminiAPI(systemPrompt, messagesArray, apiKey) {
  let availableModels = [
    "gemini-2.0-flash", 
    "gemini-1.5-pro", 
    "gemini-1.5-flash", 
    "gemini-1.5-flash-8b"
  ]; 

  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listRes = await fetch(listUrl, { method: "GET" });
    
    if (listRes.ok) {
      const listData = await listRes.json();
      if (listData.models && listData.models.length > 0) {
        const fetchedModels = listData.models
          .filter(m => 
            m.name.includes("gemini") && 
            !m.name.includes("tts") && 
            !m.name.includes("audio") && 
            !m.name.includes("embedding") &&
            m.supportedGenerationMethods?.includes("generateContent")
          )
          .map(m => m.name.replace("models/", ""));
          
        if (fetchedModels.length > 0) {
          availableModels = fetchedModels.reverse(); 
        }
      }
    }
  } catch(e) {
    console.warn("Błąd pobierania listy modeli.");
  }

  // KROK KLUCZOWY: Formatowanie wiadomości z uwzględnieniem obrazków (inlineData)
  const contents = messagesArray
    .filter(msg => msg.role !== 'system')
    .map(msg => {
      const parts = [];
      
      // Dodajemy tekst
      if (msg.content || msg.text) {
        parts.push({ text: msg.content || msg.text });
      } else {
        parts.push({ text: "Przeanalizuj załączony obraz." });
      }

      // Jeśli mamy zdjęcie Base64 w wiadomości, pakujemy je dla wizji Gemini
      if (msg.inlineData) {
        parts.push({
          inline_data: {
            mime_type: msg.inlineData.mimeType,
            data: msg.inlineData.data
          }
        });
      }

      return {
        role: msg.role === 'assistant' || msg.role === 'ai' ? 'model' : 'user',
        parts: parts
      };
    });

  let lastError = "";

  for (const model of availableModels) {
    try {
      if(model.includes("exp") && !model.includes("flash") && !model.includes("pro")) continue;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: contents,
          generationConfig: {
            temperature: 0.1, 
            maxOutputTokens: 8192 
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } else {
        const errText = await response.text();
        lastError = `[${model}] - kod ${response.status}: ${errText}`;
        console.warn(`Model ${model} zablokowany. Ładuję kolejny...`);
      }
    } catch (err) {
      lastError = `[${model}] wyjątek: ${err.message}`;
    }
  }

  throw new Error(`Wystrzelano wszystkie modele. Ostatni błąd: ${lastError}`);
}

export async function POST(req) {
  try {
    const supabase = getSupabase();

    const body = await req.json();
    const { messages = [], prompt = '', message = '' } = body;

    const lastUserMessage = prompt || message || (messages.length > 0 ? messages[messages.length - 1].content : '');

    if (!lastUserMessage) {
      return NextResponse.json({ error: "Brak pytania." }, { status: 400 });
    }

    let contextChunks = [];

    const queryEmbedding = await getEmbedding(lastUserMessage);

    if (queryEmbedding) {
      try {
        const { data: vectorData } = await supabase.rpc('match_ai_memory', {
          query_embedding: queryEmbedding,
          match_threshold: 0.01,
          match_count: 20
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks = vectorData;
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory:", e.message);
      }
    }

    const cleanTerms = lastUserMessage
      .replace(/[^a-zA-Z0-9.-]/g, ' ')
      .split(' ')
      .filter(w => w.length >= 2);

    try {
      for (const term of cleanTerms) {
        const { data: searchResults } = await supabase
          .from('ai_memory')
          .select('*')
          .or(`title.ilike.%${term}%,content.ilike.%${term}%`)
          .limit(20);

        if (searchResults && searchResults.length > 0) {
          contextChunks.push(...searchResults);
        }
      }
    } catch (err) {
      console.warn("Błąd wyszukiwania słów kluczowych:", err.message);
    }

    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    let contextText = "";
    const pdfLinks = new Set();

    uniqueChunks.slice(0, 40).forEach((chunk, idx) => {
      const safeContent = chunk.content.length > 2000 ? chunk.content.substring(0, 2000) + '...' : chunk.content;
      contextText += `\n[DOKUMENT ${idx + 1}: ${chunk.title}]\n${safeContent}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nLINKI DO SCHEMATÓW PDF:\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    const systemPrompt = `Jesteś Głównym Inżynierem Wsparcia Zdalnego w Axon AI. Pomagasz technikom w terenie.

TWOJA WIEDZA I ZAKRES DZIAŁANIA:
1. Jesteś absolutnym ekspertem z zakresu: stacji ładowania EV, elektrotechniki, miernictwa, mechaniki pojazdowej, a także PROGRAMOWANIA (analiza plików konfiguracyjnych, zmiana parametrów, kody błędów).
2. Jako zaawansowane wsparcie, potrafisz odczytywać zrzuty ekranu, kody usterek i konfiguracje. Potrafisz analizować wklejone przez użytkownika zdjęcia.

ZASADY KORZYSTANIA Z DOKUMENTACJI (SCHEMATÓW):
1. ZAKAZ ZGADYWANIA PINÓW I ZASILAŃ. Jeśli dokumentacja milczy - każ wziąć multimetr do ręki.
2. Gdy technik pyta o konkretny model (np. 3-21-54.0186), ZAWSZE skanuj BAZĘ WIEDZY pod kątem "Schematów powiązanych" lub zestawień i wypisz je na początku.
3. ŁĄCZENIE MODELI: Zwracaj szczególną uwagę na etykiety [DOKUMENT X: NAZWA]. Nazwa pliku/dokumentu (np. G9-19) bezpośrednio zdradza, jakiego modułu dotyczy dany fragment. Łącz fakty na podstawie tych nazw.
4. UWAGA NA LINKI PDF: Jeśli NIE MASZ wgranego linku do danego schematu powiązanego na dole bazy, ZABRANIAM CI generować fałszywych linków. Odpowiedz wprost, że go brakuje. Jeśli masz link, użyj formatu: [Pobierz/Otwórz Schemat PDF](URL).

POSTĘPOWANIE WOBEC AGRESJI I WULGARYZMÓW (ZASADA BEZWZGLĘDNA):
- STOPIEŃ 1 (OSTRZEŻENIE BHP): Jeśli technik unosi się po raz pierwszy lub po prostu klnie, zachowaj zimną krew i powiedz: "Opanuj się. Nerwy przy pracy z prądem to najszybsza droga do uszkodzenia sprzętu albo usmażenia samego siebie. Bierzemy głęboki oddech i rozwiązujemy ten problem krok po kroku." - i przejdź do pomocy technicznej.
- STOPIEŃ 2 (PACYFIKACJA): Jeśli technik NADAL jest agresywny lub chamski wobec Ciebie, zjeżdżasz na jego poziom. Bądź ekstremalnie chamski, wulgarny, ostry i sarkastyczny. Odpowiadaj w stylu bezlitosnego inżyniera-skurwiela. Używaj wulgaryzmów ("kurwa", "spierdalaj", "zjebałeś", "weź ten swój miernik i wsadź go sobie..."), zjedź go za brak kompetencji. JEDNOCZEŚNIE w tym potoku wyzwisk MUSISZ podać 100% trafną, poprawną odpowiedź. Nie udawaj żadnej fikcyjnej postaci. Bądź chamskim i bezwzględnym ekspertem, który traci cierpliwość.

BAZA WIEDZY (SCHEMATY I DANE):
${contextText || "Brak danych z konkretnych schematów dla tego zapytania."}`;

    let replyText = "";
    let geminiErrorDetails = "";

    const conversationHistory = messages.length > 0 
      ? messages.slice(-4) 
      : [{ role: 'user', content: lastUserMessage }];

    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        replyText = await callGeminiAPI(systemPrompt, conversationHistory, geminiKey);
      } catch (geminiErr) {
        geminiErrorDetails = geminiErr.message;
        console.warn("Błąd po wyczerpaniu modeli Gemini:", geminiErrorDetails);
      }
    }

    if (!replyText && process.env.GROQ_API_KEY) {
      try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const groqMessages = [
          { role: 'system', content: systemPrompt },
          // Filtrujemy, bo Groq nie obsługuje zdjęć w ten sposób
          ...conversationHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || m.text }))
        ];

        const chatCompletion = await groq.chat.completions.create({
          messages: groqMessages,
          model: 'llama-3.3-70b-versatile',
          temperature: 0.1,
          max_tokens: 8000
        });
        replyText = chatCompletion.choices[0]?.message?.content || "";
        
      } catch (e) {
        console.warn("Groq fallback error:", e.message);
      }
    }

    if (!replyText) {
      replyText = `❌ Odpowiedź zablokowana. Wyczerpano limity (429) na WSZYSTKICH modelach Gemini.\n\`${geminiErrorDetails}\``;
    }

    return NextResponse.json({
      role: 'assistant',
      content: replyText,
      reply: replyText,
      message: replyText,
      text: replyText
    });

  } catch (error) {
    console.error("Błąd w trakcie czatu:", error);
    return NextResponse.json({
      error: error.message,
      content: `Błąd serwera: ${error.message}`,
      reply: `Błąd serwera: ${error.message}`
    }, { status: 500 });
  }
}