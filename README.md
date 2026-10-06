# Viber Image Studio

Ứng dụng web cục bộ để tạo ảnh qua API tương thích OpenAI (`/v1/images/generations`): nhập Base URL, API key, model và prompt, xem kết quả, rồi tải ảnh về dạng PNG.

## Yêu cầu

- Node.js 20 trở lên (dùng `fetch` toàn cục và `node:test`)
- Không có dependency, không cần `npm install`, không cần build

## Chạy

```bash
npm start
```

Mở http://127.0.0.1:5173. Đổi cổng bằng biến môi trường `PORT` (ví dụ `PORT=8080 npm start`). Biến `HOST` quyết định địa chỉ lắng nghe, mặc định `127.0.0.1` (chỉ máy bạn truy cập được).

Giao diện có hai chế độ sáng/tối: mặc định theo hệ điều hành, nút ở góc phải thanh tiêu đề để đổi và lựa chọn được lưu trên trình duyệt.

## Kiểm thử

```bash
npm test
```

## Cách hoạt động

Trình duyệt gửi yêu cầu tới server cục bộ (`POST /api/generate`), server chuyển tiếp lên API và trả về nguyên trạng status, content-type và nội dung phản hồi. Nhờ vậy không bị chặn bởi CORS. Vì API hiện chỉ chấp nhận `n`=1, khi chọn n > 1 server gửi n request song song (mỗi request `n`=1) rồi gộp kết quả; nếu một request lỗi thì trả về nguyên trạng lỗi đầu tiên. Ảnh dạng URL được tải về qua `GET /api/fetch-image?url=...`.

### Base URL

Chỉ cần nhập địa chỉ gốc, ví dụ `https://bedrock.viber.vn`. Ứng dụng tự thêm `/v1/images/generations`. Dấu `/` ở cuối và đuôi `/v1/images/generations` (nếu bạn dán cả đường dẫn đầy đủ) được tự động loại bỏ để không bị lặp. Để trống sẽ dùng mặc định `https://bedrock.viber.vn`. Endpoint đầy đủ hiển thị ngay dưới ô nhập.

### Tên file tải về

- Một ảnh: `img_YYYYMMDD_HHMMSS.png`
- Nhiều ảnh: `img_YYYYMMDD_HHMMSS_1.png`, `_2.png`, ... (giờ địa phương lúc nhận phản hồi)

### Lưu trữ và bảo mật

Base URL, API key, model, prompt, kích thước và số ảnh được lưu trong `localStorage` của trình duyệt (khóa `viber-image-settings`), kể cả API key. Mọi script chạy trên cùng origin đều đọc được giá trị này, vì vậy hãy chỉ chạy ứng dụng trên máy tin cậy. API key chỉ được gửi tới server cục bộ rồi chuyển tiếp lên API, server không ghi log key.

Server cục bộ có endpoint tải ảnh theo URL bất kỳ (`/api/fetch-image`), nên đừng mở nó ra mạng ngoài.

## Docker

```bash
docker compose up -d --build
```

Mở http://localhost:5173. Đổi cổng trên máy host bằng `PORT=8080 docker compose up -d`. Cổng chỉ được publish trên `127.0.0.1` nên chỉ máy bạn truy cập được.

- Image dựa trên `node:22-alpine`, chỉ chứa `package.json`, `server.js` và `public/`, chạy bằng user `node`.
- Trong container `HOST=0.0.0.0` (bắt buộc để Docker publish cổng); việc giới hạn truy cập do `compose.yaml` đảm nhiệm.
- Có `HEALTHCHECK` gọi `/`; xem trạng thái bằng `docker compose ps`.
- Không có API key hay file `.env` nào trong image; bạn nhập key trên giao diện.
- Dừng và xoá: `docker compose down`.
