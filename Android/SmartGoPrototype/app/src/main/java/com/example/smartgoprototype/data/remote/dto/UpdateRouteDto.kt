package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

data class UpdateRouteRequestDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "title") val title: String? = null,
    @field:Json(name = "travelMode") val travelMode: String? = null,
    @field:Json(name = "userActive") val userActive: Boolean? = null,
    @field:Json(name = "arriveBy") val arriveBy: String? = null,
    @field:Json(name = "timezone") val timezone: String? = null,
    @field:Json(name = "daysOfWeek") val daysOfWeek: List<String>? = null
)

data class UpdateRouteResponseDto(
    @field:Json(name = "message") val message: String,
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "updates") val updates: List<String>? = null
)
