const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getAllCinemasForBoxchat } = require("../service/cinemaService");
const { getAllMoviesWithValidShowtimes } = require("../service/movieSevice");
const { getAllRoomForBoxchat } = require("../service/roomService");
const { getAllSeat } = require("../service/seatService");
const { getAllCombosForBoxchat } = require("../service/comboService");
const { getAllSeatTypeForBoxchat } = require("../service/seatTypeService");
const { getShowtimesByMovieIdForBoxchat, getShowtimeByIdForBoxchat } = require("../service/showtimeService");
require("dotenv").config();

// Lấy API key từ biến môi trường
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Khởi tạo Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Lưu lịch sử cuộc trò chuyện cho mỗi người dùng
// Trong một ứng dụng thực tế, bạn sẽ muốn lưu trữ điều này trong cơ sở dữ liệu
const chatHistories = new Map();

// Cache cho seat types để tránh phải gọi lại nhiều lần
let seatTypeCache = null;
let seatTypeCacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 phút

// Lấy thông tin giá vé cơ bản cho một suất chiếu
const getShowtimePrice = async (showtimeId) => {
  try {
    // Lấy dữ liệu song song để tăng hiệu suất
    const [showtimeResult, seatTypes] = await Promise.all([
      getShowtimeByIdForBoxchat(showtimeId),
      getSeatTypes()
    ]);
    
    // Xử lý cấu trúc kết quả từ API
    if (!showtimeResult || showtimeResult.status !== 200) {
      return {
        success: false,
        message: showtimeResult?.message || "Showtime information not found"
      };
    }
    
    const showtimeData = showtimeResult.showtime || {};
    const basePrice = Number(showtimeData.base_price) || 0;
      
    // Tạo thông tin về các loại ghế và giá
    const seatPrices = seatTypes.map(seatType => ({
      type: seatType.type,
      price: basePrice + Number(seatType.price_offset),
      color: seatType.color
    }));
    
    // Destructuring để lấy dữ liệu từ showtime
    const { id, start_time = {}, room = {}, movie = {} } = showtimeData;
    const cinema = room.cinema || {};
    
    return {
      success: true,
      base_price: String(basePrice),
      seat_prices: seatPrices,
      seat_types: seatTypes,
      showtime: {
        id,
        start_time: start_time || { dayOfWeek: "", date: "", time: "" },
        room: room.name || "Không xác định",
        cinema: cinema.name || "Không xác định",
        movie: movie.name || "Không xác định"
      }
    };
  } catch (error) {
    console.error(`Error fetching showtime price for ID ${showtimeId}:`, error.message);
    return {
      success: false,
      message: "Lỗi khi lấy thông tin giá vé: " + error.message
    };
  }
};

// Hàm helper để lấy và cache thông tin seat types
const getSeatTypes = async () => {
  // Sử dụng cache nếu còn hạn
  const now = Date.now();
  if (seatTypeCache && seatTypeCacheTime && (now - seatTypeCacheTime < CACHE_DURATION)) {
    return seatTypeCache;
  }
  
  // Lấy thông tin mới nếu cache hết hạn hoặc chưa có cache
  try {
    const seatTypes = await getAllSeatTypeForBoxchat();
    const formattedSeatTypes = seatTypes.map(type => ({
      id: type.id,
      type: type.type,
      color: type.color,
      price_offset: Number(type.price_offset)
    }));
    
    // Cập nhật cache
    seatTypeCache = formattedSeatTypes;
    seatTypeCacheTime = now;
    
    return formattedSeatTypes;
  } catch (error) {
    console.error("Error fetching seat types:", error.message);
    // Trả về mảng rỗng nếu có lỗi
    return [];
  }
};

// Controller xử lý chat với Gemini
exports.generateResponse = async (req, res) => {
  try {
    const { message, conversation } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message content is required",
      });
    }

    // Lấy dữ liệu rạp từ database
    const cinemas = await getAllCinemasForBoxchat();

    // Chuyển đổi dữ liệu cinema vào định dạng phù hợp
    const cinemaData = cinemas.map((cinema) => ({
      id: cinema.dataValues.id,
      name: cinema.dataValues.name,
      city: cinema.dataValues.city,
      district: cinema.dataValues.district,
      address: `${cinema.dataValues.street}, ${cinema.dataValues.ward}, ${cinema.dataValues.district}, ${cinema.dataValues.city}`,
      branchId: cinema.dataValues.branch_id,
    }));

    // Lấy dữ liệu phim từ database - sử dụng getAllMoviesWithValidShowtimes thay vì getAllMoviesForBoxchat
    const movies = await getAllMoviesWithValidShowtimes();

    // Chuyển đổi dữ liệu movie vào định dạng phù hợp
    const movieData = movies.map((movie) => ({
      id: movie.id,
      name: movie.name,
      description: movie.description,
      trailer: movie.trailer,
      year: movie.year,
      poster: movie.poster,
      ageRating: movie.age_rating,
      duration: movie.duration,
      country: movie.country,
      director: movie.Director
        ? {
            id: movie.Director.id,
            name: movie.Director.name,
            dob: movie.Director.dob,
            bio: movie.Director.bio,
            profilePicture: movie.Director.profile_picture,
          }
        : null,
        genres: movie.MovieGenres
        ? movie.MovieGenres
            .filter((g) => g.Genre) // loại bỏ phần tử có Genre = null
            .map((g) => ({
              id: g.Genre.id,
              name: g.Genre.name,
            }))
        : [],
      actors: movie.MovieActors
        ? movie.MovieActors.map((a) => ({
            id: a.Actor.id,
            name: a.Actor.name,
            dob: a.Actor.dob,
            bio: a.Actor.bio,
            profilePicture: a.Actor.profile_picture,
          }))
        : [],
    }));

    // Lấy dữ liệu phòng từ database
    const rooms = await getAllRoomForBoxchat();

    // Chuyển đổi dữ liệu phòng vào định dạng phù hợp
    let roomData = [];
    roomData = rooms.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      cinemaId: room.cinema_id,
      rowsCount: room.rows_count,
      columnsCount: room.columns_count,
      cinema: room.Cinema ? { name: room.Cinema.name } : null,
    }));

    // Lấy dữ liệu ghế từ database
    // Cấu trúc sẽ là { roomId: { roomName: string, seats: [] } }
    const seatsByRoom = {};
    
    // Lấy thông tin loại ghế từ database
    const seatTypes = await getAllSeatTypeForBoxchat();
   
    
    const seatTypesList = seatTypes.map(type => ({
      id: type.id,
      type: type.type,
      color: type.color,
      price_offset: Number(type.price_offset)
    }));
    
    // Tạo map để truy cập nhanh thông tin loại ghế
    const seatTypeMap = {};
    seatTypesList.forEach(type => {
      seatTypeMap[type.id] = type;
    });
    
    // Chỉ lấy ghế từ tối đa 5 phòng đầu tiên để tránh quá nhiều dữ liệu
    if (roomData && roomData.length > 0) {
      for (let i = 0; i < Math.min(5, roomData.length); i++) {
        try {
          const room = roomData[i];
          const seats = await getAllSeat(room.id);

          const seatList = seats.map((seat) => {
            // Lấy thông tin loại ghế
            const seatType = seatTypeMap[seat.type_id] || {
              type: 'Undefined',
              color: '#CCCCCC',
              price_offset: 0
            };
            
            return {
              id: seat.id,
              roomId: seat.room_id,
              seatNumber: seat.seat_number,
              seatRow: seat.seat_row,
              isEnabled: seat.is_enabled,
              typeId: seat.type_id,
              type: seatType.type,
              color: seatType.color,
              price_offset: seatType.price_offset
            };
          });
          
          // Lưu thông tin ghế theo phòng
          seatsByRoom[room.id] = {
            roomName: room.name,
            cinemaName: room.cinema ? room.cinema.name : "Không có thông tin",
            totalSeats: seatList.length,
            seats: seatList,
            seatTypes: seatTypesList
          };
        } catch (error) {
          console.error(
            `Error fetching seats for room at index ${i}:`,
            error.message
          );
        }
      }
    }

    // Lấy dữ liệu combo từ database
    const combos = await getAllCombosForBoxchat();
    
    // Chuyển đổi dữ liệu combo vào định dạng phù hợp
    const comboData = combos.map(combo => {
      const items = combo.ComboItems ? combo.ComboItems.map(item => ({
        id: item.id,
        quantity: item.quantity,
        product: item.FoodAndDrink ? {
          id: item.FoodAndDrink.id,
          name: item.FoodAndDrink.name,
          description: item.FoodAndDrink.description,
          price: item.FoodAndDrink.price,
          type: item.FoodAndDrink.type,
          image: item.FoodAndDrink.image
        } : null
      })) : [];
      
      return {
        id: combo.id,
        name: combo.name,
        price: combo.price,
        profilePicture: combo.profile_picture,
        items: items
      };
    });

    // Trong một ứng dụng thực tế, bạn sẽ muốn dùng session hoặc user ID
    // Tạm thời dùng IP
    const userId = req.ip;

    // Lấy hoặc tạo mới lịch sử trò chuyện cho người dùng
    if (!chatHistories.has(userId)) {
      // Nếu đã có conversation từ client, sử dụng nó
      if (conversation && conversation.length > 0) {
        const formattedHistory = conversation.map((msg) => ({
          role: msg.sender === "user" ? "user" : "model",
          parts: [{ text: msg.text }],
        }));
        chatHistories.set(userId, formattedHistory);
      } else {
        chatHistories.set(userId, []);
      }
    }

    const chatHistory = chatHistories.get(userId);

    // Thêm tin nhắn từ người dùng vào lịch sử
    chatHistory.push({ role: "user", parts: [{ text: message }] });

    // Tạo model chat từ Gemini
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash"
    });

    // Tạo chat từ lịch sử
    const chat = model.startChat({
      history: chatHistory,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        topP: 0.95,
        topK: 40,
      },
    });

    // Tạo thông tin giá vé
    const ticketPriceInfo = await createTicketPriceInfo(movieData);

    // Xây dựng prompt với thông tin suất chiếu
    const prompt = await buildPrompt(
      message,
      conversation || [],
      cinemaData,
      movieData,
      roomData,
      seatsByRoom,
      comboData,
      seatTypesList
    );

    // Lấy phản hồi
    const result = await chat.sendMessage(prompt);
    let response = result.response.text();
    
    // Làm sạch định dạng Markdown từ phản hồi
    response = cleanMarkdownFormatting(response);

    // Thêm phản hồi từ AI vào lịch sử
    chatHistory.push({ role: "model", parts: [{ text: response }] });

    // Giới hạn kích thước lịch sử (để tránh sử dụng quá nhiều bộ nhớ)
    if (chatHistory.length > 20) {
      chatHistories.set(userId, chatHistory.slice(-20));
    }

    // Trả về kết quả
    return res.status(200).json({
      success: true,
      response: response,
    });
  } catch (error) {
    console.error("Error in chatbot controller:", error);

    return res.status(500).json({
      success: false,
      message: "An error occurred while processing your request",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// API endpoint để lấy thông tin giá vé từ chatbot
exports.getTicketPrice = async (req, res) => {
  try {
    const { showtime_id } = req.params;
    
    if (!showtime_id) {
      return res.status(400).json({
        success: false,
        message: "Showtime ID is required"
      });
    }
    
    const priceInfo = await getShowtimePrice(showtime_id);
    
    if (!priceInfo.success) {
      return res.status(404).json({
        success: false,
        message: priceInfo.message || "Ticket price information not found"
      });
    }
    
    // Format dữ liệu trả về
    const formattedData = {
      base_price: priceInfo.base_price,
      formatted_price: Number(priceInfo.base_price).toLocaleString('vi-VN') + " đồng",
      seat_prices: priceInfo.seat_prices.map(sp => ({
        ...sp,
        formatted_price: Number(sp.price).toLocaleString('vi-VN') + " đồng"
      })),
      seat_types: priceInfo.seat_types,
      showtime: priceInfo.showtime
    };
    
    return res.status(200).json({
      success: true,
      message: "Lấy thông tin giá vé thành công",
      data: formattedData
    });
  } catch (error) {
    return handleApiError(res, error, "Có lỗi xảy ra khi lấy thông tin giá vé");
  }
};

// API endpoint để lấy thông tin về tất cả các loại ghế
exports.getAllSeatTypes = async (req, res) => {
  try {
    const seatTypes = await getSeatTypes();
    
    return res.json({
      success: true,
      message: "Get seat types successfully",
      seatTypes
    });
  } catch (error) {
    return handleApiError(res, error, "Có lỗi xảy ra khi lấy thông tin loại ghế");
  }
};

// Helper function để xử lý lỗi API một cách nhất quán
const handleApiError = (res, error, message) => {
  console.error(message + ":", error);
  
  return res.status(500).json({
    success: false,
    message: message,
    error: process.env.NODE_ENV === "development" ? error.message : undefined
  });
};

// Hàm trích xuất danh sách thể loại phim từ movieData
const extractGenres = (movieData) => {
  // Sử dụng Set để lưu trữ thể loại phim không trùng lặp
  const genreSet = new Set();
  
  // Lặp qua từng bộ phim để lấy thể loại
  movieData.forEach(movie => {
    if (movie.genres && movie.genres.length > 0) {
      movie.genres.forEach(genre => {
        if (genre.name) {
          genreSet.add(genre.name);
        }
      });
    }
  });
  
  // Chuyển Set thành mảng và sắp xếp theo alphabet
  return Array.from(genreSet).sort();
};

// Xây dựng prompt thông minh với ngữ cảnh
const buildPrompt = async (
  currentMessage,
  messageHistory = [],
  cinemaData = [],
  movieData = [],
  roomData = [],
  seatsByRoom = {},
  comboData = [],
  seatTypesList = []
) => {
  let conversationContext = "";

  // Add previous messages for context (limit to last 6 messages)
  const recentMessages = messageHistory.slice(-6);
  if (recentMessages.length > 0) {
    conversationContext = "Previous conversation:\n";

    recentMessages.forEach((msg) => {
      const role = msg.sender === "user" ? "User" : "Assistant";
      conversationContext += `${role}: ${msg.text}\n`;
    });

    conversationContext += "\n";
  }

  // Tạo chuỗi thông tin về rạp chiếu phim
  const cinemaInfo = cinemaData
    .map((cinema) => {
      return `
Cinema: ${cinema.name}
Address: ${cinema.address}
District: ${cinema.district}
City: ${cinema.city}
    `;
    })
    .join("\n");

  // Trích xuất danh sách thể loại phim
  const genresList = extractGenres(movieData);
  const genresInfo = genresList.length > 0 
    ? `AVAILABLE MOVIE GENRES:\n${genresList.map(genre => `- ${genre}`).join('\n')}\n\n` 
    : "";

  // Tạo thông tin giá vé
  const ticketPriceInfo = await createTicketPriceInfo(movieData);

  // Tạo mảng promises để lấy thông tin suất chiếu cho từng phim
  const movieInfoPromises = movieData.map(async (movie) => {
    const genres = movie.genres.map((g) => g.name).join(", ");
    const actors = movie.actors.map((a) => a.name).join(", ");
    
    // Lấy thông tin suất chiếu cho phim này
    let showtimeInfo = "";
    let bookingLinks = "";
    try {
      const showtimeResult = await getShowtimesByMovieIdForBoxchat(movie.id);
      if (showtimeResult && showtimeResult.status === 200 && showtimeResult.data && showtimeResult.data.length > 0) {
        showtimeInfo = "\nShowtimes:\n";
        bookingLinks = "\nBooking Links:\n";
        
        showtimeResult.data.forEach(dateGroup => {
          showtimeInfo += `- Date ${dateGroup.date} (${dateGroup.day}):\n`;
          
          dateGroup.cinemas.forEach(cinema => {
            showtimeInfo += `  + ${cinema.cinema_name}:\n`;
            
            cinema.showtimes.forEach(showtime => {
              const timeParts = showtime.time.split(':');
              const formattedTime = `${timeParts[0]}:${timeParts[1]}`;
              showtimeInfo += `    * ${formattedTime} - ${showtime.room_name}\n`;
              
              const bookingLink = `http://localhost:5173/booking/${showtime.id}?room_id=${showtime.room_id}`;
              bookingLinks += `- Book ${movie.name} - ${cinema.cinema_name} - ${showtime.room_name} - ${dateGroup.date} ${showtime.time}: ${bookingLink}\n`;
            });
          });
        });
        
        // Thêm bookingLinks vào showtimeInfo
        showtimeInfo += bookingLinks;
      } else {
        // Phim không có suất chiếu sẽ bị bỏ qua trong danh sách phim
        return null;
      }
    } catch (error) {
      console.error(`Error fetching showtimes for movie ${movie.id}:`, error.message);
      // Phim có lỗi lấy suất chiếu sẽ bị bỏ qua
      return null;
    }

    return `
Movie: ${movie.name}
Description: ${movie.description || "No description"}
Genre: ${genres || "No information"}
Age Rating: ${movie.ageRating || "Not rated"}
Duration: ${movie.duration ? `${movie.duration} minutes` : "Not updated"}
Country: ${movie.country || "Not updated"}
Director: ${movie.director ? movie.director.name : "Not updated"}
Cast: ${actors || "Not updated"}
Release Year: ${movie.year || "Not updated"}${showtimeInfo}
    `;
  });

  // Chờ tất cả các promise hoàn thành và lọc bỏ các phim null (không có suất chiếu)
  const resolvedMovieInfo = await Promise.all(movieInfoPromises);
  const validMovieInfo = resolvedMovieInfo.filter(info => info !== null);
  const movieInfo = validMovieInfo.join("\n");

  // Tạo chuỗi thông tin về phòng chiếu
  let roomInfo = "ROOM INFORMATION:\n";
  if (roomData && roomData.length > 0) {
    roomData.slice(0, 10).forEach((room) => {
      roomInfo += `
Room: ${room.name}
Cinema: ${room.cinema ? room.cinema.name : "No information"}
Rows: ${room.rowsCount}
Columns: ${room.columnsCount}
      `;
    });

    roomInfo += `\n(Total ${roomData.length} screening rooms in the system)\n`;
  } else {
    roomInfo += "No detailed information about screening rooms available.";
  }

  // Tạo chuỗi thông tin về loại ghế
  let seatInfo = "SEAT INFORMATION:\n";
  if (Object.keys(seatsByRoom).length > 0) {
    Object.keys(seatsByRoom).forEach(roomId => {
      const roomData = seatsByRoom[roomId];
      seatInfo += `Room "${roomData.roomName}" at "${roomData.cinemaName}": Has ${roomData.totalSeats} seats\n`;
      
      if (roomData.seats && roomData.seats.length > 0) {
        const sampleSeats = roomData.seats.slice(0, 5);
        seatInfo += `Examples: ${sampleSeats.map(s => `${s.seatRow}${s.seatNumber}`).join(", ")}\n\n`;
      }
    });

    seatInfo += `
Seat Status:
- Available: Seat is empty and can be booked
- Reserved: Seat is temporarily held
- Booked: Seat is already booked, cannot be selected
- Unavailable: Seat is not available (maintenance, damaged)
    `;
  } else {
    seatInfo += "No detailed seat information available.";
  }

  // Tạo chuỗi thông tin về combo đồ ăn
  let comboInfo = "FOOD AND BEVERAGE INFORMATION:\n";
  if (comboData && comboData.length > 0) {
    comboData.forEach((combo) => {
      const itemsDescription = combo.items.map(item => 
        `${item.quantity} x ${item.product ? item.product.name : 'Unidentified product'}`
      ).join(", ");
      
      comboInfo += `- ${combo.name}: ${itemsDescription} (${combo.price.toLocaleString('vi-VN')} VND)\n`;
    });
  }

  // Thông tin về chính sách vé và hỗ trợ
  const ticketPolicies = `
  TICKET POLICY AND SUPPORT:
  
  - Purchased tickets CANNOT BE EXCHANGED or RETURNED in any case
  - Tickets are only valid for the booked showtime
  - If there is any problem or complaint, please contact hotline: 0828477808
  - Support time: 8:00 - 22:00 all days of the week
  - Support email: support@movies-tickets.vn
  
  `;

  // Thêm thông tin về link đặt vé
  const bookingLinkInfo = `
  DIRECT BOOKING PROCESS:
  - When a user wants to book a ticket, ask them what movie they want to see, what date, and at which theater
  - Once they have all the information, provide a direct booking link for them to click (e.g. http://localhost:5173/booking/73?room_id=2)
  - No need to walk them through the step-by-step booking process, just provide the appropriate booking link
  - Once the user has provided the movie, theater, or date information, suggest appropriate showtimes from the available list
  `;

  return `${conversationContext}You are Minh, the AI assistant for B Cinemas ticket booking website.

${genresInfo}CURRENT MOVIES:
${movieInfo}

CINEMA INFORMATION:
${cinemaInfo}

${roomInfo}

${seatInfo}

${comboInfo}

${ticketPriceInfo}

TICKET POLICIES AND SUPPORT:
- Tickets CANNOT BE EXCHANGED or REFUNDED under any circumstances
- Tickets are only valid for the specific showtime booked
- For issues or complaints, please contact our hotline: 0828477808
- Support hours: 8:00 AM - 10:00 PM all days of the week
- Support email: support@movies-tickets.vn

DIRECT BOOKING PROCESS:
- When users want to book tickets, ask them which movie, date, and cinema they prefer
- Once you have the information, provide direct booking links for them to click (example: http://localhost:5173/booking/73?room_id=2)
- No need for detailed step-by-step booking instructions, just provide appropriate booking links
- When users provide movie, cinema, or viewing date information, suggest suitable showtimes from the available list

BOOKING INSTRUCTIONS:
1. Visit B Cinemas homepage
2. View currently showing movies
3. Select movie and preferred showtime
4. Choose seats and complete payment
5. Receive QR code or e-ticket via email

CONVERSATION GUIDELINES:
1. Use "I" or "me" and refer to users as "you"
2. Maintain a natural, friendly tone like a friend
3. Keep responses brief, concise, with accurate information
4. Use proper English, avoid unnecessary technical terms
5. When discussing prices, always use complete currency format (e.g., 50,000 VND)
6. NEVER use special characters for formatting (**, ##, ==)
7. When sharing URLs, provide them directly without brackets
8. For lists, only use dashes (-) or numbers (1., 2.)
9. Write full currency amounts (50,000 VND), no abbreviations
10. End with a brief open-ended question

BOOKING CONSULTATION PROCESS:
1. Ask movie: "Which movie would you like to watch?"
2. Ask date: "When would you like to watch it?"
3. Ask cinema: "Which cinema do you prefer?"
4. Provide 1-3 suitable booking links

RESPONSE PRINCIPLES:
- Keep responses brief, 2-3 sentences when possible
- Focus on essential information, omit redundant details
- No introductions, summaries, or question restatements
- No special characters for formatting
- End with a short open-ended question (1 sentence)

User: ${currentMessage}`;
};

// Hàm tạo thông tin giá vé cho prompt
const createTicketPriceInfo = async (movieData) => {
  let ticketPriceInfo = "TICKET PRICE INFORMATION:\n";
  
  try {
    const moviesForSamples = movieData.slice(0, 3);
    const showTimeSamples = await getShowtimeSamplesFromMovies(moviesForSamples);
    
    if (showTimeSamples.length > 0) {
      ticketPriceInfo += "Ticket prices vary based on factors like cinema location, time, and seat type. Here are some examples:\n\n";
      
      for (const sample of showTimeSamples) {
        const priceInfo = await getShowtimePrice(sample.id);
        if (!priceInfo.success) continue;
        
        const timeDisplay = formatShowtimeTime(sample, priceInfo);
        
        ticketPriceInfo += `- ${priceInfo.showtime.movie} at ${priceInfo.showtime.cinema} (${priceInfo.showtime.room}), ${timeDisplay}:\n`;
        
        if (priceInfo.seat_prices && priceInfo.seat_prices.length > 0) {
          priceInfo.seat_prices.forEach(seatPrice => {
            const formattedPrice = Number(seatPrice.price).toLocaleString('vi-VN');
            ticketPriceInfo += `  + ${seatPrice.type}: ${formattedPrice} VND\n`;
          });
        } else {
          const formattedBasePrice = Number(priceInfo.base_price).toLocaleString('vi-VN');
          ticketPriceInfo += `  + Base price: ${formattedBasePrice} VND\n`;
        }
        
        ticketPriceInfo += "\n";
      }
    } else {
      ticketPriceInfo += "Ticket prices vary based on cinema location, time, and seat type. Currently, no specific pricing information is available.\n";
      ticketPriceInfo += "Generally, ticket prices range from 50,000 VND to 150,000 VND depending on showtime and cinema.\n";
    }
    
    ticketPriceInfo += "\nNote: Prices may vary based on ongoing promotions and special offers. Please check the official website for the most accurate pricing.\n";
  } catch (error) {
    console.error("Error creating ticket price info:", error);
    ticketPriceInfo += "Ticket prices vary based on cinema location, time, and seat type. Please check the official website for accurate pricing.\n";
  }
  
  return ticketPriceInfo;
};

// Lấy mẫu suất chiếu từ danh sách phim
const getShowtimeSamplesFromMovies = async (movies) => {
  const showTimeSamples = [];

  // Chỉ lấy tối đa 3 phim để lấy mẫu
  const sampleSize = Math.min(3, movies.length);
  for (let i = 0; i < sampleSize; i++) {
    const movie = movies[i];
    try {
      const showtimeResult = await getShowtimesByMovieIdForBoxchat(movie.id);

      if (showtimeResult?.status === 200 && showtimeResult.data?.length > 0) {
        const dateGroup = showtimeResult.data[0]; // Ngày sớm nhất
        const { date, day, cinemas } = dateGroup;

        if (cinemas?.length > 0) {
          const cinema = cinemas[0]; // Rạp đầu tiên
          const showtimes = cinema.showtimes;

          if (showtimes?.length > 0) {
            const showtime = showtimes[0]; // Suất chiếu đầu tiên

            showTimeSamples.push({
              id: showtime.id,
              movie: movie.name,
              cinema: cinema.cinema_name,
              date: date,
              day: day,
              time: showtime.time,
              room: showtime.room_name,
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error sampling showtimes for movie ${movie.id}:`, error.message);
      // Bỏ qua phim này nếu có lỗi và tiếp tục với phim khác
    }
  }

  return showTimeSamples;
};


// Format thời gian hiển thị cho suất chiếu
const formatShowtimeTime = (sample, priceInfo) => {
  let timeDisplay = sample.time; // Mặc định sử dụng thời gian từ sample
  
  // Nếu có dữ liệu start_time từ API, sử dụng nó thay thế
  if (priceInfo.showtime?.start_time) {
    const startTime = priceInfo.showtime.start_time;
    if (startTime.dayOfWeek && startTime.date && startTime.time) {
      timeDisplay = `${startTime.date} (${startTime.dayOfWeek}), ${startTime.time}`;
    }
  }
  
  return timeDisplay;
};

// Hàm loại bỏ định dạng Markdown khỏi phản hồi
const cleanMarkdownFormatting = (text) => {
  if (!text) return "";
  
  // Loại bỏ các dấu ** (bold) - bao gồm cả khi có dấu : theo sau
  let cleaned = text.replace(/\*\*(.*?)\*\*(:)?/g, "$1$2");
  
  // Loại bỏ các dấu ** ở cuối câu
  cleaned = cleaned.replace(/\*\*(.*?)\*\*([\.,:;\?!])/g, "$1$2");
  
  // Loại bỏ các dấu ** còn lại
  cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, "$1");
  
  // Loại bỏ các dấu * (italic)
  cleaned = cleaned.replace(/\*(.*?)\*/g, "$1");
  
  // Loại bỏ các dấu # (heading)
  cleaned = cleaned.replace(/^#+\s+/gm, "");
  
  // Loại bỏ các dấu ` (code)
  cleaned = cleaned.replace(/`(.*?)`/g, "$1");
  
  // Loại bỏ dấu gạch chân __ hoặc _ (underscore)
  cleaned = cleaned.replace(/__(.*?)__/g, "$1");
  cleaned = cleaned.replace(/_(.*?)_/g, "$1");
  
  // Loại bỏ dấu ~~ (strikethrough)
  cleaned = cleaned.replace(/~~(.*?)~~/g, "$1");
  
  // Các định dạng khác cần loại bỏ
  cleaned = cleaned.replace(/==(.*?)==/g, "$1"); // Highlight
  
  // Kiểm tra lại nếu còn sót dấu **
  cleaned = cleaned.replace(/\*\*/g, "");
  
  return cleaned;
};
