'use client';

import { useState } from 'react';
import { Send, Upload, Camera } from 'lucide-react';

export default function AxonAI() {
  const [messages, setMessages] = useState([
    {
      role: 'ai',
      text: 'Witaj! Jestem głównym inżynierem Axon AI. Opisz problem lub wgraj zdjęcie tabliczki/stacji, a ja przeanalizuję schematy.',
    },
  ]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState(null);

  // Funkcja obsługująca wgrywanie zdjęcia
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setImage(file);
    }
  };

  // Główna funkcja wysyłania do naszego API (Prawdziwe połączenie)
  const handleSend = async () => {
    if (!input && !image) return;

    // Zapisujemy wartości tymczasowe
    const currentInput = input;
    const currentImage = image;

    // Dodajemy wiadomość usera do ekranu
    const userMsg = {
      role: 'user',
      text: currentInput,
      image: currentImage ? 'Wysłano zdjęcie' : null,
    };

    setMessages((prev) => [...prev, userMsg]);

    // Czyścimy inputy natychmiast po wysłaniu
    setInput('');
    setImage(null);

    // Dodajemy "myślenie" bota
    setMessages((prev) => [
      ...prev,
      {
        role: 'sys',
        text: currentImage ? 'Analizuję obraz i dokumentację...' : 'Myślę...',
      },
    ]);

    try {
      // Pakujemy dane do formatu FormData (niezbędne do wysłania pliku)
      const formData = new FormData();
      formData.append('prompt', currentInput);
      if (currentImage) formData.append('image', currentImage);

      // Prawdziwy strzał do naszego mózgu AI (API)
      const res = await fetch('/api/chat', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      // Usuwamy komunikat o ładowaniu i wrzucamy odpowiedź bota
      setMessages((prev) => {
        const newArr = prev.filter((m) => m.role !== 'sys');
        return [
          ...newArr,
          {
            role: 'ai',
            text: data.success ? data.text : 'Błąd analizy. Spróbuj ponownie.',
          },
        ];
      });
    } catch (error) {
      console.error(error);
      setMessages((prev) => {
        const newArr = prev.filter((m) => m.role !== 'sys');
        return [
          ...newArr,
          { role: 'ai', text: 'Brak połączenia z silnikiem AI.' },
        ];
      });
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b-4 border-yellow-400 p-6 text-center shadow-sm">
        <h1 className="text-2xl font-black uppercase tracking-widest text-gray-900">
          Robocop
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Połączono z silnikiem Gemini. Prześlij zdjęcie tabliczki lub opisz
          problem.
        </p>
      </header>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${
              msg.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            {msg.role === 'sys' ? (
              <div className="text-xs text-yellow-600 font-bold uppercase tracking-wider animate-pulse">
                {msg.text}
              </div>
            ) : (
              <div
                className={`max-w-[85%] p-4 rounded-xl shadow-sm ${
                  msg.role === 'ai'
                    ? 'bg-white border-l-4 border-yellow-400 text-gray-800'
                    : 'bg-gray-800 text-white'
                }`}
              >
                {msg.image && (
                  <div className="mb-2 text-xs opacity-70 flex items-center gap-1">
                    <Camera size={14} /> {msg.image}
                  </div>
                )}
                {/* Używamy pre-wrap aby zachować entery z odpowiedzi AI */}
                <div className="whitespace-pre-wrap">{msg.text}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input Area */}
      <div className="bg-white p-4 border-t border-gray-200">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <label className="cursor-pointer p-3 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors">
            <Upload size={20} />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </label>

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder={
              image
                ? 'Dodaj opis do zdjęcia...'
                : 'Zadaj pytanie (np. jaki to błąd?)...'
            }
            className="flex-1 p-3 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition-all"
          />

          <button
            onClick={handleSend}
            disabled={!input && !image}
            className="p-3 bg-yellow-400 hover:bg-yellow-500 disabled:bg-gray-300 disabled:cursor-not-allowed text-black font-bold rounded-lg transition-colors flex items-center gap-2"
          >
            <Send size={20} />
            <span className="hidden sm:inline uppercase text-sm tracking-wider">
              Wyślij
            </span>
          </button>
        </div>
        {image && (
          <div className="text-xs text-green-600 font-bold mt-2 text-center">
            Zdjęcie gotowe do wysłania: {image.name}
          </div>
        )}
      </div>
    </div>
  );
}
