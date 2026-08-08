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

// Pobieranie wektora zapytania
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

// INTELIGENTNA integracja z Google Gemini - Dynamiczne pobieranie listy modeli z silnym filtrem
async function callGeminiAPI(systemPrompt, messagesArray, apiKey) {
  let targetModel = "gemini-1.5-flash"; // Bezpieczna wartość domyślna

  // KROK 1: Dynamiczne zapytanie do Google o dostępne modele i rygorystyczne filtrowanie
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listRes = await fetch(listUrl, { method: "GET" });
    
    if (listRes.ok) {
      const listData = await listRes.json();
      if (listData.models && listData.models.length > 0) {
        
        // Wyciągamy modele flash, ale wyrzucamy TTS, Audio, Vision i Embeddingi
        const flashModels = listData.models
          .filter(m => 
            m.name.includes("gemini") && 
            m.name.includes("flash") && 
            !m.name.includes("tts") && 
            !m.name.includes("audio") && 
            !m.name.includes("vision") && 
            m.supportedGenerationMethods?.includes("generateContent")
          )
          .map(m => m.name.replace("models/", ""));
          
        if (flashModels.length > 0) {
          // Staramy się unikać wersji 'preview' oraz 'exp' na rzecz stabilnych wydań
          const stableModels = flashModels.filter(m => !m.includes("preview") && !m.includes("exp"));
          
          targetModel = stableModels.length > 0 
            ? stableModels[stableModels.length - 1] 
            : flashModels[flashModels.length - 1];
            
          console.log("Dynamicznie wybrano STABILNY model Gemini:", targetModel);
        }
      }
    }
  } catch(e) {
    console.warn("Błąd podczas pobierania dynamicznej listy modeli Gemini. Używam modelu awaryjnego.");
  }

  // KROK 2: Przygotowanie formatu dla Google i wykonanie właściwego strzału
  const contents = messagesArray
    .filter(msg => msg.role !== 'system')
    .map(msg => ({
      role: msg.role === 'assistant' || msg.role === 'ai' ? 'model' : 'user',
      parts: [{ text: msg.content || msg.text || "..." }]
    }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
  
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
        maxOutputTokens: 2048
      }
    })
  });

  if (response.ok) {
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) return text;
  } else {
    const errText = await response.text();
    throw new Error(`${response.status} na modelu ${targetModel} - ${errText}`);
  }

  throw new Error(`Żaden z modeli nie zwrócił poprawnej odpowiedzi. Testowany: ${targetModel}`);
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

    // 1. SZEROKIE WYSZUKIWANIE WEKTOROWE
    const queryEmbedding = await getEmbedding(lastUserMessage);

    if (queryEmbedding) {
      try {
        const { data: vectorData } = await supabase.rpc('match_ai_memory', {
          query_embedding: queryEmbedding,
          match_threshold: 0.01,
          match_count: 8
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks = vectorData;
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory:", e.message);
      }
    }

    // 2. SZEROKIE WYSZUKIWANIE TEKSTOWE
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
          .limit(8);

        if (searchResults && searchResults.length > 0) {
          contextChunks.push(...searchResults);
        }
      }
    } catch (err) {
      console.warn("Błąd wyszukiwania słów kluczowych:", err.message);
    }

    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    // 3. PRZYGOTOWANIE BAZY WIEDZY
    let contextText = "";
    const pdfLinks = new Set();

    uniqueChunks.slice(0, 12).forEach((chunk, idx) => {
      const safeContent = chunk.content.length > 1500 ? chunk.content.substring(0, 1500) + '...' : chunk.content;
      contextText += `\n[DOKUMENT ${idx + 1}: ${chunk.title}]\n${safeContent}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nLINKI DO SCHEMATÓW PDF:\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    // 4. RYGORYSTYCZNY PROMPT INŻYNIERSKI
    const systemPrompt = `Jesteś Głównym Inżynierem Wsparcia Zdalnego w Axon AI. Pomagasz technikom w terenie.

TWOJA ROLA:
1. Masz potężną wiedzę ogólną o stacjach ładowania EV (SLAC, PLC, ISO 15118), elektronice, miernictwie i BHP. Używaj jej do doradzania i tłumaczenia zjawisk technicznych.
2. Gdy technik pyta o KONKRETNE piny, indeksy lub sposób okablowania dla danego modelu, oprzyj się WYŁĄCZNIE na poniższej BAZIE WIEDZY.
3. ZAKAZ ZGADYWANIA ZASILAŃ I PINÓW. Jeśli dokumentacja milczy, powiedz: "Nie mam podanego tego na schemacie, upewnij się miernikiem".
4. Jeśli w BAZIE WIEDZY znajduje się link URL do pliku PDF, ZAWSZE umieść go w odpowiedzi jako markdown: [Pobierz/Otwórz Schemat PDF](URL).

BAZA WIEDZY (SCHEMATY):
${contextText || "Brak danych z konkretnych schematów dla tego zapytania."}`;

    let replyText = "";
    let geminiErrorDetails = "";

    const conversationHistory = messages.length > 0 
      ? messages.slice(-4) 
      : [{ role: 'user', content: lastUserMessage }];

    // 5. WYWOŁANIE GOOGLE GEMINI (Główne)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        replyText = await callGeminiAPI(systemPrompt, conversationHistory, geminiKey);
      } catch (geminiErr) {
        geminiErrorDetails = geminiErr.message;
        console.warn("Błąd silnika Gemini:", geminiErrorDetails);
      }
    }

    // 6. FALLBACK GROQ (TYLKO model 70B - ratunkowy)
    if (!replyText && process.env.GROQ_API_KEY) {
      try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const groqMessages = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || m.text }))
        ];

        const chatCompletion = await groq.chat.completions.create({
          messages: groqMessages,
          model: 'llama-3.3-70b-versatile',
          temperature: 0.1,
        });
        replyText = chatCompletion.choices[0]?.message?.content || "";
        
      } catch (e) {
        console.warn("Groq fallback error:", e.message);
      }
    }

    if (!replyText) {
      replyText = `❌ Odpowiedź zablokowana.\nSzczegóły błędu Google Gemini:\n\`${geminiErrorDetails}\``;
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