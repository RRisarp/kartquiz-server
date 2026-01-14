const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Konfigurera CORS för både Express och Socket.io
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'https://kartquiz-frontend-production.up.railway.app'],
  credentials: true
}));

const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://kartquiz-frontend-production.up.railway.app'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Lagring för aktiva quiz-rum
const rooms = new Map();

// Lagring för sparade quiz (tillfälligt i minnet, flyttas till databas senare)
const savedQuizzes = new Map();

// Hjälpfunktion för att beräkna avstånd (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Jordens radie i km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Beräkna poäng baserat på avstånd
function calculatePoints(distance, maxDistance) {
  if (distance > maxDistance) return 0;
  return Math.round(1000 * (1 - distance / maxDistance));
}

// Socket.io anslutningar
io.on('connection', (socket) => {
  console.log(`Ny anslutning: ${socket.id}`);

  // Skapa nytt quiz-rum (Host)
  socket.on('create-room', (data) => {
    const { roomCode, quizTitle, hostName } = data;
    
    rooms.set(roomCode, {
      code: roomCode,
      title: quizTitle,
      host: {
        id: socket.id,
        name: hostName || 'Quiz Master'
      },
      players: new Map(),
      questions: [],
      currentQuestion: 0,
      state: 'lobby', // lobby, question, results, finished
      guesses: new Map(),
      scores: new Map()
    });

    socket.join(roomCode);
    socket.emit('room-created', { roomCode, success: true });
    console.log(`Rum skapat: ${roomCode} av ${socket.id}`);
  });

  // Lägg till frågor till quiz
  socket.on('set-questions', (data) => {
    const { roomCode, questions } = data;
    const room = rooms.get(roomCode);
    
    if (room && room.host.id === socket.id) {
      room.questions = questions;
      socket.emit('questions-set', { success: true });
      console.log(`Frågor tillagda till rum ${roomCode}: ${questions.length} st`);
    }
  });

  // Spelare går med i rum
  socket.on('join-room', (data) => {
    const { roomCode, playerName } = data;
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('join-error', { message: 'Rummet finns inte' });
      return;
    }

    // Lägg till spelare
    const playerColor = `hsl(${Math.random() * 360}, 70%, 60%)`;
    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      color: playerColor
    });
    room.scores.set(socket.id, 0);

    socket.join(roomCode);
    socket.emit('join-success', { 
      roomCode, 
      playerId: socket.id,
      quizTitle: room.title 
    });

    // Meddela alla i rummet om ny spelare
    const playerList = Array.from(room.players.values());
    io.to(roomCode).emit('player-list-updated', { players: playerList });
    
    console.log(`${playerName} (${socket.id}) gick med i rum ${roomCode}`);
  });

  // Starta quiz (Host)
  socket.on('start-quiz', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (room && room.host.id === socket.id) {
      room.state = 'question';
      room.currentQuestion = 0;
      
      // Skicka första frågan (utan rätt svar!)
      const question = room.questions[0];
      const questionData = {
        questionNumber: 1,
        totalQuestions: room.questions.length,
        text: question.text,
        imageUrl: question.imageUrl,
        audioUrl: question.audioUrl,
        maxDistance: question.maxDistance,
        timeLimit: question.timeLimit || 0
      };

      io.to(roomCode).emit('quiz-started', questionData);
      console.log(`Quiz startat i rum ${roomCode}`);
    }
  });

  // Spelare skickar gissning
  socket.on('submit-guess', (data) => {
    const { roomCode, lat, lng } = data;
    const room = rooms.get(roomCode);

    if (room && room.players.has(socket.id)) {
      room.guesses.set(socket.id, { lat, lng });
      
      // Meddela host om antal gissningar
      const guessCount = room.guesses.size;
      const totalPlayers = room.players.size;
      
      io.to(room.host.id).emit('guess-count-updated', {
        guessCount,
        totalPlayers
      });

      socket.emit('guess-submitted', { success: true });
      console.log(`Gissning från ${socket.id} i rum ${roomCode}`);
    }
  });

  // Visa resultat (Host)
  socket.on('show-results', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (room && room.host.id === socket.id) {
      room.state = 'results';
      const currentQ = room.questions[room.currentQuestion];
      
      // Beräkna poäng för alla gissningar
      const results = [];
      
      room.guesses.forEach((guess, playerId) => {
        const player = room.players.get(playerId);
        const distance = calculateDistance(
          currentQ.correctLat,
          currentQ.correctLng,
          guess.lat,
          guess.lng
        );
        const points = calculatePoints(distance, currentQ.maxDistance);
        
        // Uppdatera total poäng
        const currentScore = room.scores.get(playerId) || 0;
        room.scores.set(playerId, currentScore + points);
        
        results.push({
          playerId,
          playerName: player.name,
          playerColor: player.color,
          guess: { lat: guess.lat, lng: guess.lng },
          distance: Math.round(distance),
          points,
          totalScore: currentScore + points
        });
      });

      // Sortera efter poäng (högst först)
      results.sort((a, b) => b.totalScore - a.totalScore);

      // Skicka resultat till alla
      io.to(roomCode).emit('results-ready', {
        correctAnswer: {
          lat: currentQ.correctLat,
          lng: currentQ.correctLng
        },
        results,
        questionNumber: room.currentQuestion + 1,
        totalQuestions: room.questions.length
      });

      console.log(`Resultat visade i rum ${roomCode}`);
    }
  });

  // Nästa fråga (Host)
  socket.on('next-question', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);

    if (room && room.host.id === socket.id) {
      room.currentQuestion++;
      room.guesses.clear();
      
      if (room.currentQuestion < room.questions.length) {
        room.state = 'question';
        const question = room.questions[room.currentQuestion];
        
        const questionData = {
          questionNumber: room.currentQuestion + 1,
          totalQuestions: room.questions.length,
          text: question.text,
          imageUrl: question.imageUrl,
          audioUrl: question.audioUrl,
          maxDistance: question.maxDistance,
          timeLimit: question.timeLimit || 0
        };

        io.to(roomCode).emit('next-question-ready', questionData);
        console.log(`Nästa fråga i rum ${roomCode}: ${room.currentQuestion + 1}`);
      } else {
        // Quiz slut
        room.state = 'finished';
        
        // Skapa final leaderboard
        const finalScores = Array.from(room.scores.entries()).map(([playerId, score]) => ({
          playerId,
          playerName: room.players.get(playerId).name,
          score
        })).sort((a, b) => b.score - a.score);

        io.to(roomCode).emit('quiz-finished', { 
          leaderboard: finalScores,
          winner: finalScores[0]
        });
        
        console.log(`Quiz avslutat i rum ${roomCode}`);
      }
    }
  });

  // Frånkoppling
  socket.on('disconnect', () => {
    console.log(`Frånkopplad: ${socket.id}`);
    
    // Ta bort spelare från alla rum
    rooms.forEach((room, roomCode) => {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        room.scores.delete(socket.id);
        room.guesses.delete(socket.id);
        
        const playerList = Array.from(room.players.values());
        io.to(roomCode).emit('player-list-updated', { players: playerList });
        
        console.log(`Spelare borttagen från rum ${roomCode}`);
      }
      
      // Om host kopplar från, ta bort rummet
      if (room.host.id === socket.id) {
        io.to(roomCode).emit('host-disconnected');
        rooms.delete(roomCode);
        console.log(`Rum ${roomCode} stängt (host frånkopplad)`);
      }
    });
  });

  // Hämta sparade quiz
  socket.on('get-saved-quizzes', () => {
    const quizzes = Array.from(savedQuizzes.values());
    socket.emit('saved-quizzes-list', { quizzes });
  });

  // Spara quiz
  socket.on('save-quiz', (data) => {
    const { id, title, questions } = data;
    savedQuizzes.set(id, {
      id,
      title,
      questions,
      createdAt: new Date().toISOString()
    });
    socket.emit('quiz-saved', { success: true, id });
    console.log(`Quiz sparat: ${title} (ID: ${id})`);
  });

  // Ladda quiz
  socket.on('load-quiz', (data) => {
    const { id } = data;
    const quiz = savedQuizzes.get(id);
    if (quiz) {
      socket.emit('quiz-loaded', { success: true, quiz });
      console.log(`Quiz laddat: ${quiz.title}`);
    } else {
      socket.emit('quiz-loaded', { success: false, message: 'Quiz hittades inte' });
    }
  });

  // Ta bort quiz
  socket.on('delete-quiz', (data) => {
    const { id } = data;
    savedQuizzes.delete(id);
    socket.emit('quiz-deleted', { success: true, id });
    console.log(`Quiz borttaget: ${id}`);
  });
});

// Enkel health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Starta server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   KartQuiz Server Igång! 🗺️             ║
║                                        ║
║   Port: ${PORT}                         ║
║   Status: Redo för anslutningar        ║
║                                        ║
║   Endpoints:                           ║
║   - Socket.io: ws://localhost:${PORT}   ║
║   - Health: http://localhost:${PORT}/health ║
╚════════════════════════════════════════╝
  `);
});
