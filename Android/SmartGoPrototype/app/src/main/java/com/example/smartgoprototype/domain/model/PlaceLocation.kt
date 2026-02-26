package com.example.smartgoprototype.domain.model

data class PlaceLocation(
    val placeId: String,
    val name: String?,
    val address: String?,
    val lat: Double? = null,
    val lng: Double? = null
)
