package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

data class ForecastRecommendationDto(
    @field:Json(name = "adjustedDepartBy") val adjustedDepartBy: String,
    @field:Json(name = "extraBufferMins") val extraBufferMins: Int,
    @field:Json(name = "reasoning") val reasoning: String,
    @field:Json(name = "mlLo") val mlLo: Double?,
    @field:Json(name = "mlHi") val mlHi: Double?
)

data class ForecastDayDto(
    @field:Json(name = "forecastDate") val forecastDate: String,
    @field:Json(name = "recommendation") val recommendation: ForecastRecommendationDto,
    @field:Json(name = "hasWeatherData") val hasWeatherData: Boolean,
    @field:Json(name = "hasEventData") val hasEventData: Boolean,
    @field:Json(name = "hasRoadworksData") val hasRoadworksData: Boolean,
    @field:Json(name = "hasTransitData") val hasTransitData: Boolean,
    @field:Json(name = "hasHolidayData") val hasHolidayData: Boolean
)

data class ForecastDto(
    @field:Json(name = "days") val days: Map<String, ForecastDayDto>,
    @field:Json(name = "generatedAt") val generatedAt: String
)
