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

// Integracja z Google Gemini API (Bezpośredni strzał do stabilnej wersji)
async function callGeminiAPI(systemPrompt, messagesArray, apiKey) {
  // Używamy stabilnej wersji 1.5-flash, omijając awaryjny endpoint ListModels
  const targetModel = "gemini-1.5-flash"; 

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
        temperature: 0.0, // Absolutne 0 - zero kreatywności, tylko fakty
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
    throw new Error(`Błąd ${response.status}: ${errText}`);
  }

  throw new Error("Pusta odpowiedź od Gemini.");
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
          match_count: 8 // Zwiększono z 5 do 8
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
          .limit(8); // Zwiększono z 4 do 8 dla każdego słowa kluczowego

        if (searchResults && searchResults.length > 0) {
          contextChunks.push(...searchResults);
        }
      }
    } catch (err) {
      console.warn("Błąd wyszukiwania słów kluczowych:", err.message);
    }

    // Usunięcie duplikatów
    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    // 3. PRZYGOTOWANIE BAZY WIEDZY (Potężny zastrzyk kontekstu)
    let contextText = "";
    const pdfLinks = new Set();

    // Bierzemy aż do 12 fragmentów, każdy do 2000 znaków (Gemini ma ogromny limit, poradzi sobie z tym bez problemu)
    uniqueChunks.slice(0, 12).forEach((chunk, idx) => {
      const safeContent = chunk.content.length > 2000 ? chunk.content.substring(0, 2000) + '...' : chunk.content;
      contextText += `\n[DOKUMENT ${idx + 1}: ${chunk.title}]\n${safeContent}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nLINKI DO SCHEMATÓW PDF:\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    // 4. RYGORYSTYCZNY SYSTEM PROMPT
    const systemPrompt = `Jesteś Głównym Inżynierem Wsparcia Zdalnego (Remote Support Senior Engineer) w Axon AI. Pomagasz technikom pracującym w terenie.

    TWOJA WIEDZA I ROLA:
    1. Masz potężną wiedzę z zakresu elektrotechniki, automatyki, miernictwa, wszelkiego programowania, bezpieczeństwa (BHP) i stacji ładowania EV oraz pojazdow EV. 
    2. Zachowuj się jak starszy kolega z serwisu. Tłumacz pojęcia (np. SLAC, PLC, różnicówki), doradzaj jak wykonać pomiary multimetrem, ostrzegaj przed zagrożeniami (np. co się stanie przy zwarciu) i podpowiadaj logiczne kroki diagnostyczne.
    
    ZASADY KORZYSTANIA Z BAZY WIEDZY (SCHEMATÓW):
    1. Gdy technik pyta o KONKRETNE przypisanie pinów, numery części, bezpieczniki lub sposób okablowania dla danego modelu – używaj WYŁĄCZNIE informacji z poniższej BAZY WIEDZY.
    2. ZAKAZ ZGADYWANIA PINÓW I ZASILAŃ. Jeśli na schemacie nie jest napisane, że moduł ma zasilanie 24VDC, nie zakładaj tego z góry. Powiedz: "Według dokumentacji nie mam podanego napięcia zasilania dla tego pinu, zmierz to ostrożnie multimetrem lub sprawdź tabliczkę na module."
    3. Jeżeli w BAZIE WIEDZY znajduje się link URL do pliku PDF ze schematem, ZAWSZE umieść go w odpowiedzi w formacie Markdown: [Pobierz/Otwórz Schemat PDF](URL).
    
    BAZA WIEDZY DOKUMENTACJI TECHNICZNEJ (SCHEMATY):
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

    // 6. FALLBACK GROQ (TYLKO potężny model 70B, wyrzucamy halucynujący 8B)
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
          temperature: 0.0,
        });
        replyText = chatCompletion.choices[0]?.message?.content || "";
        
      } catch (e) {
        console.warn("Groq fallback error:", e.message);
      }
    }

    if (!replyText) {
      replyText = `❌ Odpowiedź zablokowana. Wykorzystano darmowe pule tokenów Groq (limit dobowy) oraz napotkano błąd autoryzacji Gemini.\n\nSzczegóły błędu Google Gemini (sprawdź klucz w Vercelu!):\n\`${geminiErrorDetails}\``;
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