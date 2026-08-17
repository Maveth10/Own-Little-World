'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Camera, Bot, Trash2, Plus, Mic, MicOff, X, Paperclip, BookOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function AxonAI() {
  const defaultMessage = {
    role: 'ai',
    text: 'Witaj! Jestem głównym inżynierem Axon AI. Opisz problem, podaj symbol stacji, zrób zdjęcie aparatem lub wklej (Ctrl+V) zrzut ekranu ze schematu.',
  };

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isClient, setIsClient] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const messagesEndRef = useRef(null);
  const galleryInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(() => {
    setIsClient(true);
    const savedChat = localStorage.getItem('axon_chat_history');
    if (savedChat) {
      try {
        setMessages(JSON.parse(savedChat));
      } catch (e) {
        setMessages([defaultMessage]);
      }
    } else {
      setMessages([defaultMessage]);
    }

    // Inicjalizacja rozpoznawania mowy (Web Speech API)
    if (typeof window !== 'undefined') {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'pl-PL';

        recognition.onresult = (event) => {
          let currentTranscript = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            currentTranscript += event.results[i][0].transcript;
          }
          setInput((prev) => (prev ? `${prev} ${currentTranscript}` : currentTranscript));
        };

        recognition.onerror = (err) => {
          console.warn("Błąd rozpoznawania mowy:", err);
          setIsListening(false);
        };

        recognition.onend = () => {
          setIsListening(false);
        };

        recognitionRef.current = recognition;
      }
    }
  }, []);

  useEffect(() => {
    if (isClient && messages.length > 0) {
      const historyToSave = messages.filter(m => m.role !== 'sys');
      localStorage.setItem('axon_chat_history', JSON.stringify(historyToSave));
    }
  }, [messages, isClient]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Obsługa podglądu obrazka przy wyborze/wklejeniu
  const handleSetImage = (file) => {
    if (!file) return;
    setImage(file);
    const reader = new FileReader();
    reader.onload = () => {
      setImagePreview(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = (e) => {
    const file = e.target.files ? e.target.files[0] : null;
    if (file) handleSetImage(file);
    setShowPlusMenu(false);
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          const timestamp = new Date().toLocaleTimeString().replace(/:/g, '-');
          handleSetImage(new File([file], `Wklejony_zrzut_${timestamp}.png`, { type: file.type }));
          break;
        }
      }
    }
  };

  const toggleListening = () => {
    if (!recognitionRef.current) {
      alert("Twoja przeglądarka nie obsługuje dyktowania mowy.");
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const removeSelectedImage = () => {
    setImage(null);
    setImagePreview(null);
  };

  const handleSend = async () => {
    if ((!input.trim() && !image) || loading) return;

    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }

    const currentInput = input;
    const currentImage = image;
    const currentPreview = imagePreview;

    let base64Image = null;
    let mimeType = null;

    if (currentImage) {
      const fullBase64 = currentPreview || await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(currentImage);
      });
      base64Image = fullBase64.split(',')[1];
      mimeType = currentImage.type;
    }

    const userMsgForState = {
      role: 'user',
      text: currentInput,
      imageName: currentImage?.name,
      imagePreview: currentPreview,
      base64Image,
      mimeType
    };

    setMessages((prev) => [...prev, userMsgForState]);
    setInput('');
    setImage(null);
    setImagePreview(null);
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: 'sys', text: currentImage ? 'Analizuję obraz wizyjnie i szukam w bazie...' : 'Szukam w bazie wiedzy...' },
    ]);

    try {
      const historyForApi = messages
        .filter((m) => m.role === 'user' || m.role === 'ai')
        .map((m) => {
          const apiMsg = { role: m.role === 'user' ? 'user' : 'assistant', content: m.text };
          if (m.base64Image) {
            apiMsg.inlineData = { data: m.base64Image, mimeType: m.mimeType };
          }
          return apiMsg;
        });

      const newApiMsg = { role: 'user', content: currentInput };
      if (base64Image) {
        newApiMsg.inlineData = { data: base64Image, mimeType };
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: currentInput,
          message: currentInput,
          messages: [...historyForApi, newApiMsg],
        }),
      });

      const data = await res.json();
      const replyText = data.content || data.reply || data.text || data.message || data.error;

      setMessages((prev) => {
        const newArr = prev.filter((m) => m.role !== 'sys');
        return [...newArr, { role: 'ai', text: res.ok && replyText ? replyText : `Błąd API: ${data.error}` }];
      });
    } catch (error) {
      setMessages((prev) => {
        const newArr = prev.filter((m) => m.role !== 'sys');
        return [...newArr, { role: 'ai', text: 'Błąd połączenia z serwerem AI. Spróbuj ponownie.' }];
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = () => {
    if (window.confirm('Czy na pewno chcesz wyczyścić historię czatu?')) {
      setMessages([defaultMessage]);
      localStorage.removeItem('axon_chat_history');
    }
  };

  if (!isClient) return <div className="h-screen bg-gray-100 flex items-center justify-center font-bold">Ładowanie systemu...</div>;

  return (
    <div className="flex flex-col h-screen bg-gray-100 font-sans text-gray-900 relative">
      <header className="bg-white border-b-4 border-yellow-400 p-4 text-center shadow-sm shrink-0 relative flex items-center justify-between px-4 md:px-8 z-10">
        <div className="flex items-center gap-2">
          <Bot className="text-yellow-500" size={28} />
          <div className="text-left">
            <h1 className="text-lg md:text-xl font-black uppercase tracking-wider text-gray-900 leading-none">
              Robocop Axon AI
            </h1>
            <p className="text-[10px] md:text-xs text-gray-500 font-medium mt-0.5">Wsparcie Techniczne w Terenie</p>
          </div>
        </div>

        <button 
          onClick={handleClearHistory}
          className="flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 font-bold text-xs rounded-lg transition-colors border border-red-200"
        >
          <Trash2 size={14} /> <span className="hidden sm:inline">Wyczyść</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 z-0">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            {msg.role === 'sys' ? (
              <div className="text-xs text-yellow-600 font-bold uppercase tracking-wider animate-pulse bg-yellow-50 px-3 py-1 rounded-full border border-yellow-200">
                ⏳ {msg.text}
              </div>
            ) : (
              <div className={`max-w-[90%] md:max-w-[80%] p-4 md:p-5 rounded-2xl shadow-sm text-sm md:text-base leading-relaxed ${
                  msg.role === 'ai' ? 'bg-white border-l-4 border-yellow-400 text-gray-900' : 'bg-gray-900 text-white font-medium'
                }`}
              >
                {/* Wymierny podgląd miniatury na czacie dla wysłanych zdjęć */}
                {msg.imagePreview && (
                  <div className="mb-3">
                    <img 
                      src={msg.imagePreview} 
                      alt="Załącznik" 
                      className="max-h-48 rounded-lg border border-gray-700 object-cover shadow-sm"
                    />
                    {msg.imageName && (
                      <span className="text-[10px] opacity-60 font-mono mt-1 block">{msg.imageName}</span>
                    )}
                  </div>
                )}
                
                {msg.role === 'ai' ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      table: ({ node, ...props }) => <div className="overflow-x-auto my-4"><table className="w-full text-left border-collapse border border-gray-300 text-sm" {...props} /></div>,
                      th: ({ node, ...props }) => <th className="border border-gray-300 bg-gray-100 px-4 py-2 font-bold text-gray-800" {...props} />,
                      td: ({ node, ...props }) => <td className="border border-gray-300 px-4 py-2 text-gray-700" {...props} />,
                      strong: ({ node, ...props }) => <strong className="font-bold text-gray-900" {...props} />,
                      ul: ({ node, ...props }) => <ul className="list-disc pl-5 my-2 space-y-1" {...props} />,
                      ol: ({ node, ...props }) => <ol className="list-decimal pl-5 my-2 space-y-1" {...props} />,
                      a: ({ node, ...props }) => (
                        <a href={props.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2 mt-2 bg-yellow-400 hover:bg-yellow-500 text-black font-bold text-xs md:text-sm rounded-lg shadow-sm transition-colors border border-yellow-500 cursor-pointer no-underline">
                          📄 {props.children}
                        </a>
                      ),
                    }}
                  >
                    {msg.text}
                  </ReactMarkdown>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{msg.text}</div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="bg-white p-3 md:p-4 border-t border-gray-200 shadow-[0_-4px_20px_rgba(0,0,0,0.05)] shrink-0 relative z-20">
        
        {/* PODGLĄD ZDJĘCIA PRZED WYSŁANIEM */}
        {imagePreview && (
          <div className="max-w-4xl mx-auto mb-3 flex items-center gap-3 bg-gray-50 p-2 rounded-xl border border-gray-200 w-fit relative group shadow-sm">
            <img src={imagePreview} alt="Podgląd" className="w-14 h-14 object-cover rounded-lg border border-gray-300" />
            <div className="pr-6">
              <p className="text-xs font-bold text-gray-800 truncate max-w-[200px]">{image?.name || 'Obraz ze schowka'}</p>
              <p className="text-[10px] text-green-600 font-semibold">Gotowe do analizy wizyjnej</p>
            </div>
            <button 
              onClick={removeSelectedImage}
              className="absolute -top-2 -right-2 bg-gray-800 hover:bg-red-500 text-white p-1 rounded-full shadow-md transition-colors border border-white"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* UKRYTE INPUTY DLA APARATU I GALERII */}
        <input 
          type="file" 
          accept="image/*" 
          ref={galleryInputRef} 
          className="hidden" 
          onChange={handleImageUpload} 
          disabled={loading} 
        />
        <input 
          type="file" 
          accept="image/*" 
          capture="environment" 
          ref={cameraInputRef} 
          className="hidden" 
          onChange={handleImageUpload} 
          disabled={loading} 
        />

        {/* ROZWIJANE MENU W STYLU GEMINI (Ciemny motyw) */}
        {showPlusMenu && (
          <>
            {/* Niewidzialna warstwa zamykająca menu przy kliknięciu w tło */}
            <div className="fixed inset-0 z-40" onClick={() => setShowPlusMenu(false)}></div>
            
            <div className="absolute bottom-20 left-4 md:left-auto bg-[#1e1e1e] text-gray-200 border border-gray-700 rounded-2xl shadow-2xl py-2 z-50 flex flex-col w-64 animate-in fade-in slide-in-from-bottom-2 font-medium">
              
              <button
                onClick={() => { galleryInputRef.current?.click(); setShowPlusMenu(false); }}
                className="flex items-center gap-4 px-4 py-3 hover:bg-white/10 transition-colors text-sm text-left"
              >
                <Paperclip size={18} className="text-gray-400" />
                <span>Prześlij pliki z Galerii</span>
              </button>

              <button
                onClick={() => { cameraInputRef.current?.click(); setShowPlusMenu(false); }}
                className="flex items-center gap-4 px-4 py-3 hover:bg-white/10 transition-colors text-sm text-left"
              >
                <Camera size={18} className="text-gray-400" />
                <span>Zrób zdjęcie (Aparat)</span>
              </button>

              <div className="h-px bg-gray-700 my-1 mx-4" />

              <button
                onClick={() => window.location.href = '/teach'}
                className="flex items-center gap-4 px-4 py-3 hover:bg-white/10 transition-colors text-sm text-left"
              >
                <BookOpen size={18} className="text-gray-400" />
                <span>Tryb nauki (Wgraj schemat)</span>
              </button>
            </div>
          </>
        )}

        <div className="max-w-4xl mx-auto flex items-center gap-2">
          
          {/* PRZYCISK PLUS (+) */}
          <button
            onClick={() => setShowPlusMenu(!showPlusMenu)}
            disabled={loading}
            className={`p-3 rounded-full transition-colors flex items-center justify-center shrink-0 ${
              showPlusMenu ? 'bg-gray-200 text-gray-900 rotate-45' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            }`}
          >
            <Plus size={22} className="transition-transform duration-200" />
          </button>

          {/* INPUT TEKSTOWY */}
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            onPaste={handlePaste} 
            disabled={loading}
            placeholder={isListening ? 'Słucham... dyktuj teraz...' : 'Zapytaj AI lub wklej (Ctrl+V)...'}
            className={`flex-1 p-3 bg-gray-100 text-gray-900 placeholder-gray-500 rounded-2xl border-none focus:outline-none focus:ring-2 focus:ring-gray-300 transition-all font-medium text-sm md:text-base ${
              isListening ? 'bg-red-50 text-red-900 placeholder-red-400 ring-2 ring-red-300' : ''
            }`}
          />

          {/* PRZYCISK MIKROFONU */}
          <button
            onClick={toggleListening}
            disabled={loading}
            title={isListening ? 'Zatrzymaj dyktowanie' : 'Dyktuj mowę'}
            className={`p-3 rounded-full transition-colors flex items-center justify-center shrink-0 ${
              isListening 
                ? 'bg-red-500 text-white animate-pulse shadow-md' 
                : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
            }`}
          >
            {isListening ? <MicOff size={22} /> : <Mic size={22} />}
          </button>

          {/* PRZYCISK WYSŁANIA */}
          <button 
            onClick={handleSend} 
            disabled={(!input.trim() && !image) || loading} 
            className="p-3 bg-gray-900 hover:bg-black disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-bold rounded-full transition-colors flex items-center justify-center shrink-0 shadow-sm"
          >
            <Send size={20} className="ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
}