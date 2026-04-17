package com.example.smartgoprototype.domain.model

enum class ForecastStatus { ACTIVE, PENDING, EMPTY }

data class ForecastRecommendation(
    val adjustedDepartBy: String, // ISO 8601 UTC
    val extraBufferMins: Int,
    val reasoning: String,
    val mlLo: Double?,
    val mlHi: Double?
)

data class ForecastDay(
    val forecastDate: String,
    val recommendation: ForecastRecommendation,
    val hasWeatherData: Boolean,
    val hasEventData: Boolean,
    val hasRoadworksData: Boolean,
    val hasTransitData: Boolean,
    val hasHolidayData: Boolean
)

/**
 * Day-keyed forecast for a route. Keys are 3-letter day codes: MON, TUE, WED, THU, FRI, SAT, SUN.
 */
data class RouteForecast(
    val days: Map<String, ForecastDay>,
    val generatedAt: String
)
