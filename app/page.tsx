'use client';

import { useState } from 'react';
import { Send, Upload, Camera, Bot } from 'lucide-react';

export default function AxonAI() {
  const [messages, setMessages] = useState([
    {
      role: 'ai',
      text: 'Witaj! Jestem głównym inżynierem Axon AI. Opisz problem lub podaj symbol stacji/komponentu, a ja przeanalizuję schematy.',
    },
  ]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState(null);
  const [loading, setLoading] = useState(false);

  // Funkcja zamieniająca kod Markdown [Tytuł](URL) na czysty, klikalny przycisk
  const renderFormattedText = (text) => {
    if (!text) return null;

    const markdownLinkRegex = /\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = markdownLinkRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }

      const linkTitle = match[1] || 'Otwórz Schemat PDF';
      const linkUrl = match[2];

      parts.push(
        <span key={match.index} className="block my-2">
          <a
            href={linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-400 hover:bg-yellow-500 text-black font-bold text-xs md:text-sm rounded-lg shadow-sm transition-colors border border-yellow-500 cursor-pointer no-underline"
          >
            📄 {linkTitle}
          </a>
        </span>
      );

      lastIndex = markdownLinkRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return parts.length > 0 ? parts : text;
  };

  const handleImageUpload = (e) => {
    const file = e.target.files ? e.target.files[0] : null;
    if (file) {
      setImage(file);
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && !image) || loading) return;

    const currentInput = input;
    const currentImage = image;

    const userMsg = {
      role: 'user',
      text: currentInput,
      image: currentImage ? currentImage.name : null,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setImage(null);
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      {
        role: 'sys',
        text: currentImage ? 'Analizuję treść i szukam w bazie wiedzy...' : 'Szukam w bazie wiedzy i generuję odpowiedź...',
      },
    ]);

    try {
      const historyForApi = messages
        .filter((m) => m.role === 'user' || m.role === 'ai')
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.text,
        }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: currentInput,
          message: currentInput,
          messages: [...historyForApi, { role: 'user', content: currentInput }],
        }),
      });

      const data = await res.json();
      const replyText = data.content || data.reply || data.text || data.message || data.error;

      setMessages((prev) => {
        const newArr = prev.filter((m) => m.role !== 'sys');
        return [
          ...newArr,
          {
            role: 'ai',
            text: res.ok && replyText ? replyText : `Błąd API: ${data.error || 'Nie udało się uzyskać odpowiedzi.'}`,
          },
        ];
      });
    } catch (error) {
      console.error(error);
      setMessages((prev) => {
        const newArr = prev.filter((m) => m.role !== 'sys');
        return [
          ...newArr,
          { role: 'ai', text: 'Błąd połączenia z serwerem AI. Spróbuj ponownie.' },
        ];
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100 font-sans text-gray-900">
      {/* Header */}
      <header className="bg-white border-b-4 border-yellow-400 p-5 text-center shadow-sm">
        <h1 className="text-2xl font-black uppercase tracking-widest text-gray-900 flex items-center justify-center gap-2">
          <Bot className="text-yellow-500" size={28} /> Robocop Axon AI
        </h1>
        <p className="text-xs text-gray-500 mt-1 font-medium">
          Wyszukiwanie schematów w bazie ai_memory | Silnik Llama 70B
        </p>
      </header>

      {/* Area Czatu */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            {msg.role === 'sys' ? (
              <div className="text-xs text-yellow-600 font-bold uppercase tracking-wider animate-pulse bg-yellow-50 px-3 py-1 rounded-full border border-yellow-200">
                ⏳ {msg.text}
              </div>
            ) : (
              <div
                className={`max-w-[85%] md:max-w-[75%] p-4 rounded-xl shadow-sm text-sm md:text-base leading-relaxed ${
                  msg.role === 'ai'
                    ? 'bg-white border-l-4 border-yellow-400 text-gray-900'
                    : 'bg-gray-900 text-white font-medium'
                }`}
              >
                {msg.image && (
                  <div className="mb-2 text-xs opacity-80 flex items-center gap-1 font-mono bg-black/20 p-1.5 rounded">
                    <Camera size={14} /> Załącznik: {msg.image}
                  </div>
                )}
                {/* PARSER TEKSTU Z OBSŁUGĄ KLIKALNYCH LINKÓW */}
                <div className="whitespace-pre-wrap break-words">
                  {renderFormattedText(msg.text)}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Stopka z polem wprowadzania */}
      <div className="bg-white p-4 border-t border-gray-200 shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <label className="cursor-pointer p-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors border border-gray-300">
            <Upload size={20} />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
              disabled={loading}
            />
          </label>

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            disabled={loading}
            placeholder={
              image
                ? `Załączono: ${image.name} - opisz problem...`
                : 'Zadaj pytanie (np. jaki indeks ma 1A8 w 3-21-52.0189?)...'
            }
            className="flex-1 p-3 bg-white text-gray-900 placeholder-gray-400 border border-gray-300 rounded-lg focus:outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-400 transition-all font-medium text-base"
          />

          <button
            onClick={handleSend}
            disabled={(!input.trim() && !image) || loading}
            className="p-3 bg-yellow-400 hover:bg-yellow-500 disabled:bg-gray-300 disabled:cursor-not-allowed text-black font-bold rounded-lg transition-colors flex items-center gap-2 shadow-sm"
          >
            <Send size={20} />
            <span className="hidden sm:inline uppercase text-sm tracking-wider">
              Wyślij
            </span>
          </button>
        </div>

        {image && (
          <div className="max-w-4xl mx-auto text-xs text-green-700 font-bold mt-2 flex items-center justify-between bg-green-50 p-2 rounded border border-green-200">
            <span>📷 Gotowe do analizy: {image.name}</span>
            <button
              onClick={() => setImage(null)}
              className="text-red-500 hover:underline font-semibold"
            >
              Usuń
            </button>
          </div>
        )}
      </div>
    </div>
  );
}