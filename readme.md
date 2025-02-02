
# API Binance Advanced Portfolio

Este proyecto proporciona una API desarrollada en Node.js utilizando Express, que permite consultar y analizar el portafolio de trading en Binance para un par específico. La API recupera el historial de órdenes y trades y calcula varios indicadores de rendimiento.

## Características

- Obtener todas las órdenes y trades para un par de criptomonedas específico.
- Calcular el balance total, el costo promedio y la ganancia/perdida no realizada.
- Mostrar el precio actual del par de criptomonedas.

## Configuración

### Requisitos Previos

- Node.js (versión recomendada: 14.x o superior)
- npm o yarn

### Instalación

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/apifactory-org/API-Binance-Advanced-Portfolio
   ```
2. Navegar al directorio del proyecto:
   ```bash
   cd API-Binance-Advanced-Portfolio
   ```
3. Instalar las dependencias:
   ```bash
   npm install
   # o si usas yarn
   yarn install
   ```
4. Crear un archivo `.env` en la raíz del proyecto con las siguientes variables de entorno:
   ```plaintext
   BINANCE_API_KEY=your_binance_api_key_here
   BINANCE_API_SECRET=your_binance_secret_key_here
   ```
5. Iniciar el servidor:
   ```bash
   npm start
   # o si usas yarn
   yarn start
   ```

## Uso

Una vez que el servidor esté corriendo, puedes hacer solicitudes HTTP a `http://localhost:3000/orders?symbol=PAIR` donde `PAIR` es el par de criptomonedas que deseas consultar (por ejemplo, `BTCUSDT`).

## Autor

- Miguel Céspedes - [GitHub](https://github.com/apifactory-org)

## Licencia

Este proyecto está bajo la Licencia MIT - ver el archivo `LICENSE` para más detalles.
