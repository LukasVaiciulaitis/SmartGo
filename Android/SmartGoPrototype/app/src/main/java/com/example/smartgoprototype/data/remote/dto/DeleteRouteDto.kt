package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

data class DeleteRouteRequestDto(
    @field:Json(name = "routeId") val routeId: String
)

data class DeleteRouteResponseDto(
    @field:Json(name = "message") val message: String,
    @field:Json(name = "routeId") val routeId: String
)
