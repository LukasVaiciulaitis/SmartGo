# SmartGo

> Commute delay prediction and route management for Android, powered by serverless AWS and machine learning.

[![Deploy Backend](https://github.com/LukasVaiciulaitis/SmartGo/actions/workflows/deploy-backend.yml/badge.svg)](https://github.com/LukasVaiciulaitis/SmartGo/actions/workflows/deploy-backend.yml)
[![Deploy Dagon](https://github.com/LukasVaiciulaitis/SmartGo/actions/workflows/deploy-dagon.yml/badge.svg)](https://github.com/LukasVaiciulaitis/SmartGo/actions/workflows/deploy-dagon.yml)
[![Deploy Sage](https://github.com/LukasVaiciulaitis/SmartGo/actions/workflows/deploy-sage.yml/badge.svg)](https://github.com/LukasVaiciulaitis/SmartGo/actions/workflows/deploy-sage.yml)

---

## Overview

SmartGo lets commuters save their regular routes and receive delay forecasts before they leave. The system scrapes real-time traffic, transit, weather, events, and roadworks data nightly, feeds it into a machine learning pipeline, and surfaces predictions through a native Android app.

---

## Architecture

```
┌─────────────┐     REST API      ┌───────────────────────────────────┐
│   Android   │ ◄───────────────► │  Backend (AWS Lambda + API GW)    │
│  (Kotlin)   │                   │  • Route CRUD (4 Lambdas)         │
└─────────────┘                   │  • Nightly scrapers (7 Lambdas)   │
                                  │  • DynamoDB · SQS · Cognito       │
                                  └───────────────┬───────────────────┘
                                                  │
                      ┌───────────────────────────┼───────────────────────────┐
                      ▼                           ▼                           ▼
           ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
           │  Dagon Pipeline  │──────►│  Sage ML Pipeline│──────►│   SageMaker      │
           │  Commute data    │  S3   │  Train road/rail │       │  Endpoints       │
           │  collection      │       │  delay models    │       │  (inference)     │
           └──────────────────┘       └──────────────────┘       └──────────────────┘
```

| Component | Purpose | Runtime |
|-----------|---------|---------|
| **Android** | Mobile client — route management, delay forecasts, departure notifications | Kotlin + Jetpack Compose |
| **Backend** | Serverless REST API + nightly data scrapers | Node.js 20.x on AWS Lambda |
| **Dagon** | Research data pipeline — collects commute snapshots for model training | Node.js 20.x on AWS Lambda |
| **Sage** | ML training + deployment pipeline | Python 3 (scikit-learn) + Node.js |

---

## Tech Stack

**Android**
- Kotlin · Jetpack Compose · Room · Hilt · DataStore
- Retrofit + OkHttp · AWS Amplify (Cognito) · Google Places API

**Backend / Dagon / Sage**
- AWS SAM (CloudFormation) · Lambda · API Gateway · DynamoDB · SQS · EventBridge · Cognito · SageMaker · Step Functions · SNS · SSM
- External APIs: Google Routes · TomTom · Open-Meteo · Ticketmaster · Transitland (GTFS)

**CI/CD**
- GitHub Actions — separate deploy workflows per component

---

## Getting Started

### Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with deployment credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- [Node.js 20+](https://nodejs.org/)
- [Android Studio](https://developer.android.com/studio) (for mobile development)
- API keys for: Google Routes, TomTom, Ticketmaster, Transitland

### Deploying the Backend

```bash
cd Backend
sam build
sam deploy --guided
```

### Deploying Dagon (data pipeline)

```bash
cd Dagon
sam build
sam deploy --guided
```

### Deploying Sage (ML pipeline)

```bash
cd Sage
sam build
sam deploy --guided
```

### Running the Android App

Open `Android/SmartGoPrototype` in Android Studio, configure your `local.properties` with the deployed API endpoint, then run on a device or emulator.

---

## Project Structure

```
SmartGo/
├── Android/          # Kotlin Android app
├── Backend/          # REST API + nightly scrapers (SAM)
├── Dagon/            # Commute data collection pipeline (SAM)
└── Sage/             # ML training & SageMaker deployment (SAM)
```

---

## License

This project is for research and educational purposes.
