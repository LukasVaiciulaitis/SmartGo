package com.example.smartgoprototype.domain.model

data class PlaceLocation(
    val placeId: String,
    val label: String,
    val addressComponents: List<GoogleAddressComponent>? = null
)